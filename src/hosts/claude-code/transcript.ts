import { open, stat } from "node:fs/promises";

const isBrainTool = (name: unknown): boolean =>
  typeof name === "string" && (name.includes("brain_search") || name.includes("brain_mutate"));
const isBrainMutate = (name: unknown): boolean => typeof name === "string" && name.includes("brain_mutate");

// The current turn always lives at the END of the transcript, so we read only the TAIL instead of the whole
// file. This keeps the Stop-hook cost flat as a conversation grows: an 18MB session would otherwise be read
// (and parsed) in full on every single turn end. The window is generous enough to hold any one turn; if a
// turn somehow exceeds it we just scope to the recent tail (a harmless relaxation, never a stale cache, so
// the per-turn freshness the gate relies on is preserved).
const TAIL_BYTES = 1_048_576; // 1 MiB

// Read the tail of the transcript and return the parsed message lines of the CURRENT turn: from the last
// real user prompt (a user message with STRING content; tool results carry ARRAY content) to EOF. Returns
// null on any read failure so each caller can apply its own fail-safe.
async function currentTurnLines(path: string): Promise<string[] | null> {
  let text: string;
  let truncated = false;
  try {
    const { size } = await stat(path);
    const start = Math.max(0, size - TAIL_BYTES);
    truncated = start > 0;
    const fh = await open(path, "r");
    try {
      const buf = Buffer.alloc(size - start);
      await fh.read(buf, 0, buf.length, start);
      text = buf.toString("utf8");
    } finally {
      await fh.close();
    }
  } catch {
    return null;
  }
  let lines = text.split("\n").filter(Boolean);
  if (truncated && lines.length) lines = lines.slice(1); // a truncated read can start mid-line; drop it
  let start = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const o = JSON.parse(lines[i]!);
      if (o.type === "user" && typeof o.message?.content === "string") { start = i + 1; break; }
    } catch { /* skip malformed line */ }
  }
  return lines.slice(start);
}

// Did the agent call brain_search/brain_mutate during the current turn? Fail safe (true) on a read error so
// we never nag on uncertainty.
export async function brainUsedThisTurn(transcriptPath: string): Promise<boolean> {
  const lines = await currentTurnLines(transcriptPath);
  if (lines === null) return true;
  for (const line of lines) {
    try {
      const content = JSON.parse(line).message?.content;
      if (Array.isArray(content)) for (const c of content) if (c?.type === "tool_use" && isBrainTool(c.name)) return true;
    } catch { /* skip malformed line */ }
  }
  return false;
}

// Node ids the agent answered (via brain_mutate) during the current turn. The split-leaves gate is scoped to
// these so it nags about the agent's OWN fresh syntheses, never the whole historical graph. Fail open (empty
// set) on a read error so we never nag on uncertainty.
export async function mutatedIdsThisTurn(transcriptPath: string): Promise<Set<string>> {
  const ids = new Set<string>();
  const lines = await currentTurnLines(transcriptPath);
  if (lines === null) return ids;
  for (const line of lines) {
    try {
      const content = JSON.parse(line).message?.content;
      if (!Array.isArray(content)) continue;
      for (const c of content) {
        if (c?.type === "tool_use" && isBrainMutate(c.name) && typeof c.input?.id === "string") ids.add(c.input.id);
      }
    } catch { /* skip malformed line */ }
  }
  return ids;
}
