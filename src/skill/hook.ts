import { homedir } from "node:os";
import { join } from "node:path";
import { writeFileSync, mkdirSync } from "node:fs";
import { skillsEnabled } from "../core/config";
import { retrieveSkills, condenseMessages, injectionText, skillInstructions, explainInjection, retrieveDiagnostic } from "./retrieve";
import { learnFromTranscript } from "./learn";
import { registerInflight } from "./coordinate";

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
  if (!skillsEnabled() || !text.trim()) return "";
  try {
    const query = condenseMessages([text]);
    const matches = await retrieveSkills(query);
    // Register only the TOP match as in-flight for coordination. Registering every match (k=2) left the
    // non-reviewed skill orphaned as a 'doing' file each turn, and those orphans piled up and blocked later
    // reviews via peersBusy. The doer still gets all matched masters; only the single best skill is tracked.
    if (sessionId && matches[0]) registerInflight(sessionId, matches[0].skill.task, Date.now());
    const skills = matches.map((m) => m.skill);
    const injected = injectionText(skillInstructions(skills), explainInjection(skills));
    // On a 0-match, record WHY (empty store / embed failure / near-miss scores) so the bare "0" is diagnosable.
    let why = "";
    if (!matches.length && process.env.CAIRN_SKILL_DEBUG !== "0") {
      const d = await retrieveDiagnostic(query);
      why = `\nWHY 0: store=${d.storeCount} skills, embed=${d.embedOk ? `ok(dim ${d.embedDim})` : "FAILED"}, threshold=${d.threshold}, top: ${d.top.map((t) => `${t.task} ${t.score.toFixed(3)}`).join(", ") || "(store empty)"}`;
    }
    writeInjectionDebug(injected, matches, why);
    return injected || "";
  } catch { return ""; }
}

// On turn end: fire the background learner over the turn's transcript. Returns whether it fired. No-op when
// disabled, with no path, or for a SUBAGENT's stop: a subagent is spawned to do part of the parent task (a
// short-story master spawns a reviewer subagent), so its stop is not its own learnable turn. Learning from it
// would run the learner twice and form a spurious sibling skill (the parent transcript already includes the
// subagent's contribution, so nothing is lost by skipping it).
export function skillLearn(transcriptPath: string | undefined, isSubagent = false): boolean {
  if (!skillsEnabled() || !transcriptPath || isSubagent) return false;
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
