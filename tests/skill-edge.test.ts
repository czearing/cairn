import { test, expect, beforeEach } from "bun:test";
import { readSegment } from "../src/skill/reviewer";
import { isSystemEnvelope } from "../src/skill/noise";
import { normalizeLabel, categorize } from "../src/skill/match";
import { putSkill } from "../src/skill/store";
import { db } from "../src/core/db";

beforeEach(() => {
  try { db().run("DELETE FROM skills"); } catch { /* not created */ }
  try { db().run("DELETE FROM skill_runs"); } catch { /* not created */ }
});

test("isSystemEnvelope flags host/system wrapper messages, not genuine prompts", () => {
  expect(isSystemEnvelope("<task-notification> <task-id>b1</task-id> done")).toBe(true);
  expect(isSystemEnvelope("  <system_reminder> use AGENTS.md")).toBe(true);   // leading whitespace tolerated
  expect(isSystemEnvelope("<skill-context name=\"playwright-cli\">")).toBe(true);
  expect(isSystemEnvelope("<command-message>code</command-message>")).toBe(true);
  expect(isSystemEnvelope("write me a short story about a lighthouse")).toBe(false);
  expect(isSystemEnvelope("why do we have labels?")).toBe(false);             // meta/complaint is the segmenter's job, not this
  expect(isSystemEnvelope("")).toBe(false);
});

// ---- reader hostility: a malformed/empty capture must yield null (not submitted) or a clean list ----

test("readSegment: null when nothing was submitted; clean rows when it was", () => {
  expect(readSegment(null)).toBeNull();          // tool never called
  expect(readSegment("not json")).toBeNull();    // unreadable capture
  expect(readSegment('{"deliverables":[]}')).toEqual([]); // submitted a non-task (empty list)
  expect(readSegment('{"deliverables":[{"label":"Haiku","what":"the frost haiku"}]}')).toEqual([{ label: "haiku", what: "the frost haiku" }]);
});

test("readSegment: dedups by label and drops blank labels", () => {
  const out = readSegment('{"deliverables":[{"label":"haiku","what":"a"},{"label":"haiku","what":"b"},{"label":"","what":"c"}]}');
  expect(out).toEqual([{ label: "haiku", what: "a" }]);
});

test("normalizeLabel: empty and all-punctuation collapse to empty, never throw", () => {
  expect(normalizeLabel("")).toBe("");
  expect(normalizeLabel("!!!")).toBe("");
  expect(normalizeLabel("WRITE A HAIKU")).toBe("haiku");
});

test("categorize tolerates a stored skill with a corrupt/empty vector via the exact-label key", async () => {
  putSkill({ id: "corrupt", task: "sonnet", masterPrompt: "", ts: 1 }, []); // no vector
  const a = await categorize("haiku", 1, () => "H1");
  expect(a.created).toBe(true);
  const b = await categorize("write a haiku", 2, () => "NOPE"); // exact-matches H1 despite the corrupt neighbor
  expect(b.created).toBe(false);
  expect(b.skill.id).toBe("H1");
});
