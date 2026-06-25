import { runClaude } from "./claude";
import { LABEL_SYSTEM, labelUserPrompt } from "./prompts";

// Reduce a messy user request to its canonical skill label(s) via a tool-free claude -p call. One request
// can hold several tasks ("a haiku and a poem"), so this returns a list, one clean label per task. The
// labeler does the messy-to-canonical reduction that embeddings cannot do reliably (topic dominates raw
// text). Returns [] on failure (caller treats as unlabeled).

/** Pure: turn the labeler's raw stdout into clean, de-duplicated labels (one per line). Strips bullets,
 *  numbering, quotes, and case. Exported for deterministic tests. */
export function parseLabels(raw: string): string[] {
  const seen = new Set<string>(), out: string[] = [];
  for (const line of raw.split("\n")) {
    const l = line.trim().replace(/^[-*\d.)\s]+/, "").replace(/^["'`]+|["'`]+$/g, "").trim().toLowerCase();
    // require a letter/digit and reject angle brackets, so bullets, code fences (```), pure punctuation,
    // and echoed prompt scaffolding (<request>, </request>) never become labels.
    if (l && l.length <= 40 && /[a-z0-9]/.test(l) && !/[<>]/.test(l) && !seen.has(l)) { seen.add(l); out.push(l); }
  }
  return out;
}

// `existing` is the current set of skill labels; passing it makes the labeler reuse one if it fits, so the
// same intent converges to one skill instead of drifting across synonyms.
export async function labelTasks(request: string, existing: string[] = [], timeoutMs?: number): Promise<string[]> {
  const res = await runClaude(labelUserPrompt(request, existing), { system: LABEL_SYSTEM, timeoutMs });
  return parseLabels(res.text);
}
