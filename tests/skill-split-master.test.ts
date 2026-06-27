import { test, expect } from "bun:test";
import { splitMaster } from "../src/skill/split-master";

test("splitMaster separates the rationale preamble from the numbered steps", () => {
  const r = splitMaster("Why the best runs win, in prose.\n\n1. do this\n2. then that")!;
  expect(r.explanation).toBe("Why the best runs win, in prose.");
  expect(r.instructions).toBe("1. do this\n2. then that");
});

test("splitMaster returns null when there is no numbered list to split on", () => {
  expect(splitMaster("just prose, no steps")).toBeNull();
});

test("splitMaster yields an empty explanation when the master is steps-only", () => {
  const r = splitMaster("1. a\n2. b")!;
  expect(r.explanation).toBe("");
  expect(r.instructions).toBe("1. a\n2. b");
});

test("splitMaster handles the 1) paren style and leading indentation", () => {
  const r = splitMaster("Rationale here.\n\n  1) first\n  2) second")!;
  expect(r.explanation).toBe("Rationale here.");
  expect(r.instructions).toBe("1) first\n  2) second");
});
