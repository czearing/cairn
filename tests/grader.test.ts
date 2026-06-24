import { test, expect } from "bun:test";
import { parseVerdict, gradePrompt } from "../src/core/grader";

// Deterministic tests for the grader's parse/validate layer (no live claude call). The live behavior is
// measured separately in scripts/grade-live.ts.

test("parseVerdict accepts a clean JSON verdict", () => {
  expect(parseVerdict('{"score":0.78,"reason":"correct 5-7-5, vivid"}')).toEqual({ score: 0.78, reason: "correct 5-7-5, vivid" });
});

test("parseVerdict extracts JSON even with surrounding prose", () => {
  const v = parseVerdict('Here is my grade:\n{"score":0.4,"reason":"flat imagery"}\nThanks.');
  expect(v?.score).toBe(0.4);
});

test("parseVerdict keeps optional per-dimension scores", () => {
  const v = parseVerdict('{"score":0.6,"reason":"ok","dims":{"form":1,"imagery":0.3}}');
  expect(v?.dims).toEqual({ form: 1, imagery: 0.3 });
});

test("parseVerdict rejects an out-of-range score (strict)", () => {
  expect(parseVerdict('{"score":1.4,"reason":"too good"}')).toBeNull();
  expect(parseVerdict('{"score":-0.2,"reason":"bad"}')).toBeNull();
});

test("parseVerdict rejects junk and missing score", () => {
  expect(parseVerdict("the haiku is lovely")).toBeNull();
  expect(parseVerdict('{"reason":"no score here"}')).toBeNull();
  expect(parseVerdict("")).toBeNull();
  expect(parseVerdict(null)).toBeNull();
});

test("parseVerdict coerces a stringified number", () => {
  expect(parseVerdict('{"score":"0.5","reason":"x"}')?.score).toBe(0.5);
});

test("gradePrompt includes task, output, and a JSON-only instruction", () => {
  const p = gradePrompt("write a haiku", "old pond...", "5-7-5 + imagery");
  expect(p).toContain("write a haiku");
  expect(p).toContain("old pond...");
  expect(p).toContain("5-7-5 + imagery");
  expect(p.toLowerCase()).toContain("only one line of compact json");
});
