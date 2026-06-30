import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Skill prompts live as plain .md files in ./prompts so they are trivial to read and edit without
// touching code. They are loaded once here at module init. This module runs only in the background skill
// worker and the dev loop scripts, never on the hot Claude Code hook path, so a few sync reads are fine.
// The worker is spawned fresh each turn, so an edit to any .md takes effect on the next learn run.
const DIR = join(dirname(fileURLToPath(import.meta.url)), "prompts");
const load = (name: string): string => readFileSync(join(DIR, name), "utf8").trimEnd();

// Fill {{key}} placeholders with per-call data using literal string replacement (no regex). Any key not
// provided is left untouched; an empty value collapses its line.
const fill = (template: string, vars: Record<string, string>): string =>
  Object.entries(vars).reduce((s, [k, v]) => s.replaceAll(`{{${k}}}`, v), template);

// System prompt (the learner's behavioral prompt).
export const LEARN_SYSTEM = load("learn-system.md");

// Classifier prompts. The label decision runs FIRST, with NO skill master or priors as context, so the
// classifier reads only the deliverable and cannot be anchored into mislabeling a review of X as X.
export const CLASSIFY_SYSTEM = load("classify-system.md");
const CLASSIFY_USER = load("classify-user.md");

export function classifyUserPrompt(request: string, output: string, transcript: string, existing: string[]): string {
  return fill(CLASSIFY_USER, {
    existing: existing.length ? existing.map((e) => `- ${e}`).join("\n") : "(none yet)",
    request, output, transcript: transcript.trim() || "(not recorded)",
  });
}

// User-message template. The .md holds the wording; this builder fills in the per-call data.
const LEARN_USER = load("learn-user.md");

// The request to label, the deliverable to grade, the raw run transcript (the process, so the learner can
// see where the agent struggled or was corrected), the existing labels (for reuse), and the prior runs.
// The single learner call assigns the label, grades, and rewrites the master, submitting via skill_output.
export function learnUserPrompt(request: string, output: string, transcript: string, existing: string[], priors: { quality: number; review: string }[], priorMaster = "", priorExplanation = "", focus = ""): string {
  // Cap each prior so the prompt can never balloon (the learner only needs the gist of each past run).
  const priorsText = priors.length ? priors.map((r) => `- q=${r.quality.toFixed(2)} ${r.review.slice(0, 500)}`).join("\n") : "(none yet)";
  // When the turn produced several deliverables (e.g. a story AND its review), the loop grades them one at a
  // time and names which one HERE, so the learner scores exactly that deliverable, not the whole turn.
  const focusText = focus.trim()
    ? `GRADE ONLY THIS DELIVERABLE from the turn, ignoring any others it produced (e.g. grade the review, not the story it reviews): ${focus.trim()}\n`
    : "";
  return fill(LEARN_USER, {
    focus: focusText,
    existing: existing.length ? existing.join(", ") : "(none yet)",
    request, priors: priorsText, transcript: transcript.trim() || "(not recorded)", output,
    currentMaster: priorMaster.trim() || "(none yet, this is the first version)",
    currentExplanation: priorExplanation.trim() || "(none yet)",
  });
}
