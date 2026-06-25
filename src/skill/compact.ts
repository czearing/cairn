import { runClaude } from "./claude";
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

// Rebuild a clean markdown table from parsed rows, so a stored recipe never carries the model's stray
// preamble even when it ignores "output only the table".
export function renderTable(rows: CompactRow[]): string {
  return ["| timestamp | step | result |", "| --- | --- | --- |", ...rows.map((r) => `| ${r.timestamp} | ${r.step} | ${r.result} |`)].join("\n");
}

// Spawn a Claude (local CLI, no API key) to compact one conversation into a recipe table. Compaction
// needs no brain access (only the reviewer does), so this runs tool-free and isolated. Returns the
// structured rows plus a CLEAN reconstructed table (no model preamble). Empty rows means it produced none.
export async function compactConversation(transcript: string, timeoutMs?: number): Promise<{ rows: CompactRow[]; raw: string }> {
  const res = await runClaude(compactionUserPrompt(transcript), { system: COMPACTION_SYSTEM, timeoutMs });
  const rows = parseTable(res.text);
  return { rows, raw: rows.length ? renderTable(rows) : res.text.trim() };
}
