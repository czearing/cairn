import { readFile } from "node:fs/promises";

const isBrainTool = (name: unknown): boolean =>
  typeof name === "string" && (name.includes("brain_search") || name.includes("brain_mutate"));

// Did the agent call brain_search/brain_mutate since the last real user prompt?
// In Claude Code transcripts a real prompt has STRING `message.content`; tool results have
// ARRAY content — so the last string-content user line marks the start of this turn.
// On any read/parse failure we return true (fail safe — never nag on uncertainty).
export async function brainUsedThisTurn(transcriptPath: string): Promise<boolean> {
  let text: string;
  try {
    text = await readFile(transcriptPath, "utf8");
  } catch {
    return true;
  }
  const lines = text.split("\n").filter(Boolean);

  let start = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const o = JSON.parse(lines[i]!);
      if (o.type === "user" && typeof o.message?.content === "string") { start = i + 1; break; }
    } catch { /* skip malformed line */ }
  }

  for (let i = start; i < lines.length; i++) {
    try {
      const content = JSON.parse(lines[i]!).message?.content;
      if (Array.isArray(content)) {
        for (const c of content) if (c?.type === "tool_use" && isBrainTool(c.name)) return true;
      }
    } catch { /* skip malformed line */ }
  }
  return false;
}
