import { test, expect, beforeEach } from "bun:test";
import { normalizeLabel, categorize, matchSkill } from "../src/skill/match";
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

test("a distinct form stays a separate skill (haiku vs poem)", async () => {
  await categorize("haiku", 1, () => "S1");
  const p = await categorize("poem", 2, () => "S2");
  expect(p.created).toBe(true);              // poem is not merged into haiku (cosine 0.696 < 0.80 threshold)
  expect(p.skill.id).toBe("S2");
});

test("matchSkill returns null when there are no skills yet", async () => {
  expect(await matchSkill("haiku")).toBeNull();
});
