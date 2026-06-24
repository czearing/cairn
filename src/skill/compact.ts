import { runClaude } from "./claude";
import { cairnMcpConfigPath } from "./cairn-mcp";
import { COMPACTION_SYSTEM, compactionUserPrompt } from "./prompts";
import type { CompactRow } from "./types";

// Pure: parse a GitHub-flavored markdown table into rows. Tolerant of surrounding prose; skips the header
// and the |---| separator; requires exactly the three columns. Returns [] when there is no table.
export function parseTable(raw: string): CompactRow[] {
  const rows: CompactRow[] = [];
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("|") || !t.endsWith("|")) continue;
    const cells = t.slice(1, -1).split("|").map((c) => c.trim());
    if (cells.length !== 3) continue;
    const [a, b, c] = cells as [string, string, string];
    if (/^[-:\s]*$/.test(a) && /^[-:\s]*$/.test(b) && /^[-:\s]*$/.test(c)) continue; // separator row
    if (a.toLowerCase() === "timestamp" && b.toLowerCase() === "step") continue;     // header row
    rows.push({ timestamp: a, step: b, result: c });
  }
  return rows;
}

// Spawn a cairn-connected Claude (local CLI, no API key) to compact one conversation into a recipe table.
// Read-only on the brain. Returns the structured rows plus the raw table text. Empty rows means the run
// failed or produced no table.
export async function compactConversation(transcript: string, timeoutMs?: number): Promise<{ rows: CompactRow[]; raw: string }> {
  const res = await runClaude(compactionUserPrompt(transcript), {
    system: COMPACTION_SYSTEM,
    mcpConfigPath: cairnMcpConfigPath(),
    allowedTools: ["mcp__cairn__brain_search"],
    timeoutMs,
  });
  return { rows: parseTable(res.text), raw: res.text };
}
