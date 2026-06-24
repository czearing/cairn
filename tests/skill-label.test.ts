import { test, expect } from "bun:test";
import { parseLabels } from "../src/skill/label";
import { labelUserPrompt, LABEL_SYSTEM } from "../src/skill/prompts";

test("parseLabels lowercases and keeps one label per line", () => {
  expect(parseLabels("haiku\npoem")).toEqual(["haiku", "poem"]);
  expect(parseLabels("HAIKU")).toEqual(["haiku"]);
});

test("parseLabels strips bullets, numbering, and quotes", () => {
  expect(parseLabels('- Haiku\n2. Poem\n"sql query"')).toEqual(["haiku", "poem", "sql query"]);
});

test("parseLabels de-duplicates and drops blank/over-long lines", () => {
  expect(parseLabels("haiku\n\nhaiku")).toEqual(["haiku"]);
  expect(parseLabels("haiku\nthis is a whole performed sentence that is not a label at all really")).toEqual(["haiku"]);
  expect(parseLabels("")).toEqual([]);
});

test("labelUserPrompt frames the request as data to classify, not perform", () => {
  const p = labelUserPrompt("whip up a haiku about my cat");
  expect(p).toContain("<request>");
  expect(p).toContain("whip up a haiku about my cat");
  expect(p).toContain("Do NOT perform");
});

test("labelUserPrompt offers existing labels for reuse when given", () => {
  expect(labelUserPrompt("x", ["haiku", "poem"])).toContain("haiku, poem");
  expect(labelUserPrompt("x")).not.toContain("Reuse one of these");
});

test("LABEL_SYSTEM forbids performing the request", () => {
  expect(LABEL_SYSTEM.toLowerCase()).toContain("never perform");
});
