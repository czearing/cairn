import { homedir } from "node:os";
import { join } from "node:path";
import { writeFileSync, mkdirSync } from "node:fs";
import { skillsEnabled } from "../core/config";
import { retrieveSkills, condenseMessages, retrieveDiagnostic } from "./retrieve";
import { learnFromTranscript } from "./learn";
import { registerInflight } from "./coordinate";
import { skillCatalog, skillVectors } from "./store";

// Entry points the Claude Code dispatch calls. The skill feature is OFF by default (a fresh install never
// runs it); opt in per machine with `"skills": true` in ~/.cairn/config.json or CAIRN_SKILLS=1. All are
// best-effort and never throw, and do no work when disabled or when the skill store is empty.

export { skillsEnabled };

// Debug aid: every turn, dump exactly what was injected (the raw text plus each matched skill and its score)
// to a file so you can inspect it after talking to Claude. ON by default (it is one tiny best-effort write
// per user turn); set CAIRN_SKILL_DEBUG=0 to turn it off. Override the path with CAIRN_SKILL_DEBUG_FILE.
const debugFile = (): string => process.env.CAIRN_SKILL_DEBUG_FILE || join(homedir(), ".cairn", "last-injection.txt");
function writeInjectionDebug(text: string, matches: { skill: { task: string }; score: number }[], why = ""): void {
  if (process.env.CAIRN_SKILL_DEBUG === "0") return;
  try {
    const path = debugFile();
    mkdirSync(join(path, ".."), { recursive: true });
    const header = matches.length
      ? `matched ${matches.length} skill(s): ${matches.map((m) => `${m.skill.task} (${m.score.toFixed(3)})`).join(", ")}`
      : "matched 0 skills (nothing injected)";
    writeFileSync(path, `${header}${why}\n\n----- raw injected prompt -----\n${text || "(empty)"}\n`);
  } catch { /* best-effort */ }
}

// On a user message: return the curated-steps injection for the matching skill(s), or "" (disabled, no
// match, or any error). The dispatch appends this to the brain's injected context. When a sessionId is given,
// also REGISTER each matched skill as in-flight for that session (a file write, safe from the read-only hook),
// so the post-turn coordinator knows which windows are refining the same skill before they finish.
export async function skillInject(text: string, sessionId?: string): Promise<string> {
  // Auto-injection of a single cosine-matched master is DISABLED. Cosine mispicks near-duplicate skills (a
  // story-WRITING prompt scored the reviewer's skill 0.568 vs the writer's 0.536 and injected the wrong steps).
  // The agent now retrieves skills itself with the skill_search tool (instructed in the base prompt, enforced
  // by a one-shot reminder), so it disambiguates with full context. We still run the cheap match here ONLY to
  // register the in-flight skill for the post-turn coordinator and to record a diagnostic. Always returns ""
  // (nothing is appended to the agent's context).
  if (!skillsEnabled() || !text.trim()) return "";
  try {
    const query = condenseMessages([text]);
    const matches = await retrieveSkills(query);
    if (sessionId && matches[0]) registerInflight(sessionId, matches[0].skill.task, Date.now());
    let why = "";
    if (!matches.length && process.env.CAIRN_SKILL_DEBUG !== "0") {
      const d = await retrieveDiagnostic(query);
      why = `\nWHY 0: store=${d.storeCount} skills, embed=${d.embedOk ? `ok(dim ${d.embedDim})` : "FAILED"}, threshold=${d.threshold}, top: ${d.top.map((t) => `${t.task} ${t.score.toFixed(3)}`).join(", ") || "(store empty)"}`;
    }
    writeInjectionDebug("(auto-injection disabled; agent retrieves via skill_search)", matches, why);
  } catch { /* best-effort */ }
  return "";
}

// Agent-facing skill retrieval. The agent calls this (via the skill_search MCP tool) with a description of the
// task it is about to do; it gets back the top matching skills WITH their full step lists, plus the full
// catalog of skill labels, and PICKS the right one itself. Returning several candidates (not one) is what fixes
// the near-duplicate mispick: a "write a story" query surfaces both "short story" and "short story review", and
// the agent follows the writer. Empty when the skill layer is off or the store is empty.
export async function skillSearch(query: string): Promise<{ matches: { task: string; steps: string }[]; catalog: string[] }> {
  if (!skillsEnabled() || !query.trim()) return { matches: [], catalog: [] };
  try {
    const matches = (await retrieveSkills(query, 3))
      .filter((m) => m.skill.masterPrompt.trim())
      .map((m) => ({ task: m.skill.task, steps: m.skill.masterPrompt }));
    return { matches, catalog: skillCatalog() };
  } catch { return { matches: [], catalog: [] }; }
}

// True only when the skill layer is on AND at least one skill exists, so the search-first reminder never fires
// on a fresh/empty store (there would be nothing to find).
export function skillsExist(): boolean {
  if (!skillsEnabled()) return false;
  try { return skillVectors().length > 0; } catch { return false; }
}

// On turn end, INCLUDING a subagent's stop: fire the background learner over that turn's transcript. A
// subagent that did a real sub-task (e.g. the short-story reviewer the master spawns) has its OWN transcript
// and produces a DISTINCT deliverable, so it is learned as its own skill in parallel with the parent's turn.
// The learner classifies each by its deliverable, so the writer's turn forms "short story" and the reviewer's
// forms "short story review" with no special-casing. Returns whether it fired.
export function skillLearn(transcriptPath: string | undefined): boolean {
  if (!skillsEnabled() || !transcriptPath) return false;
  try { learnFromTranscript(transcriptPath); return true; } catch { return false; }
}

// For brain_search to piggyback: the matching skills as a small structured blob (capped), or [] when
// disabled / no match. Each entry is the skill's curated steps. Threshold-gated, so an unrelated search
// returns nothing.
export async function skillBlob(query: string): Promise<{ task: string; steps: string }[]> {
  if (!skillsEnabled() || !query.trim()) return [];
  try {
    return (await retrieveSkills(query, 2))
      .filter((s) => s.skill.masterPrompt.trim())
      .map((s) => ({ task: s.skill.task, steps: s.skill.masterPrompt }));
  } catch { return []; }
}
