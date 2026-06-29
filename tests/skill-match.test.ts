import { test, expect, beforeEach } from "bun:test";
import { normalizeLabel, categorize } from "../src/skill/match";
import { db } from "../src/core/db";

beforeEach(() => {
  try { db().run("DELETE FROM skills"); } catch { /* not created yet */ }
  try { db().run("DELETE FROM skill_runs"); } catch { /* not created yet */ }
});

test("normalizeLabel collapses phrasings of the same task", () => {
  expect(normalizeLabel("Write a Haiku!")).toBe("haiku");
  expect(normalizeLabel("compose a haiku")).toBe("haiku");
  expect(normalizeLabel("  haiku  ")).toBe("haiku");
  expect(normalizeLabel("write a commit message")).toBe("commit message");
});

test("a repeated task exact-matches the same skill (the restore key)", async () => {
  const a = await categorize("haiku", 1, () => "S1");
  expect(a.created).toBe(true);
  expect(a.skill.id).toBe("S1");
  // a re-phrasing normalizes identically, so it restores the SAME skill, no embedding ambiguity.
  const b = await categorize("Write a Haiku", 2, () => "SHOULD_NOT_BE_USED");
  expect(b.created).toBe(false);
  expect(b.skill.id).toBe("S1");
});

test("a distinct label stays a separate skill (haiku vs poem), never merged by similarity", async () => {
  await categorize("haiku", 1, () => "S1");
  const p = await categorize("poem", 2, () => "S2");
  expect(p.created).toBe(true);              // distinct labels never merge: routing is exact-label only, no cosine
  expect(p.skill.id).toBe("S2");
});

test("a near-duplicate label is NOT merged into an existing skill (the bug that clobbered short story)", async () => {
  await categorize("short story", 1, () => "S1");
  const r = await categorize("short story review", 2, () => "S2"); // shares 2/3 words, embeds > 0.80 cosine
  expect(r.created).toBe(true);              // a NEW skill: the classifier's distinct label is honored exactly
  expect(r.skill.id).toBe("S2");
  expect(r.skill.task).toBe("short story review");
});
