import { retrieveInjection, retrieveSkills } from "./retrieve";
import { learnFromTranscript } from "./learn";

// Entry points the Claude Code dispatch calls. The skill feature is ON by default; set CAIRN_SKILLS=0 to
// turn it off. All are best-effort and never throw, and do no work when the skill store is empty.

export const skillsEnabled = (): boolean => process.env.CAIRN_SKILLS !== "0";

// On a user message: return the curated-steps injection for the matching skill(s), or "" (disabled, no
// match, or any error). The dispatch appends this to the brain's injected context.
export async function skillInject(text: string): Promise<string> {
  if (!skillsEnabled() || !text.trim()) return "";
  try { return (await retrieveInjection([text])) ?? ""; } catch { return ""; }
}

// On turn end: fire the background learner over the turn's transcript (no-op if disabled or no path).
export function skillLearn(transcriptPath: string | undefined): void {
  if (!skillsEnabled() || !transcriptPath) return;
  try { learnFromTranscript(transcriptPath); } catch { /* best-effort */ }
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
