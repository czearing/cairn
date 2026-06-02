import { config } from "../core/config";

const isWrite = (tool: string) =>
  tool === "brain_create" || tool.endsWith("__brain_create") ||
  tool === "brain_mutate" || tool.endsWith("__brain_mutate");

// Checks a pending write against the length budget. Returns a human-readable violation message
// if the entry is too verbose, else null. Runs BEFORE the write (PreToolUse) so the dispatcher
// can deny it and send the model back to shorten — the only reliable way to constrain the
// current entry (a PreToolUse additionalContext lands too late to affect this call).
export function checkEntry(tool: string, input: Record<string, unknown>): string | null {
  if (!isWrite(tool)) return null;
  const { text, answer } = input as { text?: unknown; answer?: unknown };
  const out: string[] = [];
  if (typeof text === "string" && text.length > config.entry.maxText)
    out.push(`text is ${text.length} chars — keep it ≤ ${config.entry.maxText} (a single-line question).`);
  if (typeof answer === "string" && answer.length > config.entry.maxAnswer)
    out.push(`answer is ${answer.length} chars — keep it ≤ ${config.entry.maxAnswer} (≤ 3 short sentences).`);
  return out.length ? out.join(" ") : null;
}
