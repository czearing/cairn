import { retrieveInjection } from "./retrieve";
import { learnFromTranscript } from "./learn";

// Flag-gated entry points the Claude Code dispatch calls. The whole skill feature is OFF unless
// CAIRN_SKILLS=1, so the default brain flow is never touched. Both are best-effort and never throw.

export const skillsEnabled = (): boolean => process.env.CAIRN_SKILLS === "1";

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
