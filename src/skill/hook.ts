import { homedir } from "node:os";
import { join } from "node:path";
import { writeFileSync, mkdirSync } from "node:fs";
import { skillsEnabled } from "../core/config";
import { retrieveSkills, condenseMessages, retrieveDiagnostic } from "./retrieve";
import { learnFromTranscript } from "./learn";
import { skillCatalog, skillVectors } from "./store";

// Entry points the Claude Code dispatch calls. The skill feature is ON by default; turn it OFF per machine
// with `"skills": false` in ~/.cairn/config.json or CAIRN_SKILLS=0. All are
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

// On a user message: run the cheap skill match ONLY to record a diagnostic (what would have matched and why).
// Auto-injection of a master is disabled — the agent retrieves skills itself via skill_search — so this always
// returns "" (nothing is appended to the agent's context). Best-effort; never throws.
export async function skillInject(text: string, _sessionId?: string): Promise<string> {
  if (!skillsEnabled() || !text.trim()) return "";
  try {
    const query = condenseMessages([text]);
    const matches = await retrieveSkills(query);
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

// Agent-facing skill creation (the skill_create MCP tool). Mints a new skill for `label` when skill_search
// found nothing that fits, so the agent can then iterate it with skill_review. Idempotent: an existing label
// is returned as created:false. No-op-safe (returns created:false) when the skill layer is off.
export async function skillCreate(label: string): Promise<{ created: boolean; label: string }> {
  if (!skillsEnabled() || !label.trim()) return { created: false, label: label.trim() };
  try {
    const { categorize } = await import("./match");
    const { skill, created } = await categorize(label, Date.now());
    return { created, label: skill.task };
  } catch { return { created: false, label: label.trim() }; }
}

// True only when the skill layer is on AND at least one skill exists, so the search-first reminder never fires
// on a fresh/empty store (there would be nothing to find).
export function skillsExist(): boolean {
  if (!skillsEnabled()) return false;
  try { return skillVectors().length > 0; } catch { return false; }
}

// Fire the background learner over a finished turn's transcript, for the skill the agent DECLARED via
// skill_review. `label` is that skill (a new label auto-creates it); `focus` optionally names which
// deliverable to grade when the turn made more than one. Returns whether it fired.
export function skillLearn(transcriptPath: string | undefined, label: string, focus = ""): boolean {
  if (!skillsEnabled() || !transcriptPath || !label.trim()) return false;
  process.env.CAIRN_LEARN_BACKEND = "claude"; // Claude host: parse the Claude transcript AND grade via `claude -p`
  try { return learnFromTranscript(transcriptPath, label, focus); } catch { return false; }
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
