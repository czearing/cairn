import { test, expect } from "bun:test";
import { parseTable } from "../src/skill/compact";
import { compactionUserPrompt, COMPACTION_SYSTEM } from "../src/skill/prompts";

const TABLE = `Here is the compaction:
| timestamp | step | result |
|-----------|------|--------|
| 00:00 | draft haiku | first draft made |
| 00:05 | revise imagery | sharper, 5-7-5 ok |
Done.`;

test("parseTable extracts rows, skipping prose, header, and separator", () => {
  expect(parseTable(TABLE)).toEqual([
    { timestamp: "00:00", step: "draft haiku", result: "first draft made" },
    { timestamp: "00:05", step: "revise imagery", result: "sharper, 5-7-5 ok" },
  ]);
});

test("parseTable returns [] when there is no table", () => {
  expect(parseTable("no table here, just prose")).toEqual([]);
});

test("parseTable ignores rows that are not exactly three columns", () => {
  expect(parseTable("| a | b |\n| a | b | c | d |")).toEqual([]);
});

test("parseTable keeps a header-looking data row that is not the real header", () => {
  // "step" in the result column must not be mistaken for the header row.
  const rows = parseTable("| 00:01 | note the step | step recorded |");
  expect(rows).toEqual([{ timestamp: "00:01", step: "note the step", result: "step recorded" }]);
});

test("compactionUserPrompt embeds the transcript", () => {
  expect(compactionUserPrompt("XYZ-CONVO")).toContain("XYZ-CONVO");
});

test("system prompt demands a cairn read, table-only output, and the three columns", () => {
  expect(COMPACTION_SYSTEM).toContain("brain_search");
  expect(COMPACTION_SYSTEM).toContain("ONLY");
  expect(COMPACTION_SYSTEM).toContain("| timestamp | step | result |");
});
