import { test, expect } from "bun:test";
import { parseTable, renderTable } from "../src/skill/compact";
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

test("renderTable rebuilds a clean table that round-trips through parseTable", () => {
  const rows = [{ timestamp: "00:00", step: "draft", result: "ok" }, { timestamp: "00:05", step: "revise", result: "sharper" }];
  const t = renderTable(rows);
  expect(t.startsWith("| timestamp | step | result |")).toBe(true);
  expect(t).not.toContain("Here's"); // no model preamble can survive
  expect(parseTable(t)).toEqual(rows);
});

test("system prompt demands table-only output with the three columns and no brain access", () => {
  expect(COMPACTION_SYSTEM).toContain("ONLY");
  expect(COMPACTION_SYSTEM).toContain("| timestamp | step | result |");
  expect(COMPACTION_SYSTEM).not.toContain("brain_search"); // compaction is brain-free; only the reviewer uses cairn
});
