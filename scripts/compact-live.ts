// Live proof of the compaction step: spawn a Claude (local CLI, no API key, tool-free) that reads a
// timestamped conversation and outputs the compacted timestamp|step|result table. Prints the system
// prompt too, so it can be monitored. Run: bun scripts/compact-live.ts
import { COMPACTION_SYSTEM } from "../src/skill/prompts";
import { compactConversation } from "../src/skill/compact";

const TRANSCRIPT = `[00:00] user: write me a haiku about the first frost
[00:02] assistant: called brain_search for prior haiku runs
[00:04] assistant: drafted "first frost on the gate / a sparrow tilts its small head / the morning holds still"
[00:05] assistant: counted syllables, confirmed 5-7-5
[00:06] user: make the ending land harder
[00:09] assistant: revised line 3 to "the whole field holds its breath", reconfirmed 5-7-5
[00:10] assistant: returned the final haiku`;

console.log("=== SYSTEM PROMPT (monitor) ===\n" + COMPACTION_SYSTEM + "\n");
console.log("=== INPUT TRANSCRIPT ===\n" + TRANSCRIPT + "\n");
console.log("=== spawning claude (tool-free, this calls the real CLI)... ===\n");
const { rows, raw } = await compactConversation(TRANSCRIPT);
console.log(raw.trim());
console.log(`\nparsed ${rows.length} rows: ${JSON.stringify(rows)}`);
