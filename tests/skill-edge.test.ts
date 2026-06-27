import { test, expect, beforeEach } from "bun:test";
import { parseReview, parseLearn } from "../src/skill/reviewer";
import { normalizeLabel, categorize } from "../src/skill/match";
import { putSkill } from "../src/skill/store";
import { db } from "../src/core/db";

beforeEach(() => {
  try { db().run("DELETE FROM skills"); } catch { /* not created */ }
  try { db().run("DELETE FROM skill_runs"); } catch { /* not created */ }
});

// ---- parser hostility: a consumer LLM returns messy output; nothing should crash or yield garbage ----

test("parseLearn: missing master section, missing label, and a normal split", () => {
  expect(parseLearn(null)).toEqual({ label: null, review: null, master: null, explanation: null });
  expect(parseLearn('{"label":"haiku","score":0.5,"right":"","wrong":"","improve":""}')).toMatchObject({ label: "haiku", master: null });
  const both = parseLearn('{"label":"haiku","score":0.9,"right":"a","wrong":"b","improve":"c"}\n===MASTER===\nWhy.\n\n1. step');
  expect(both.label).toBe("haiku");
  expect(both.review?.score).toBe(0.9);
  expect(both.master).toContain("1. step");
});

test("parseLearn: empty label string is treated as no label (non-task)", () => {
  expect(parseLearn('{"label":"","score":0.4,"right":"","wrong":"","improve":""}').label).toBeNull();
});

test("parseReview: out-of-range, missing, junk, and nested braces", () => {
  expect(parseReview('{"score":2,"right":"x"}')).toBeNull();
  expect(parseReview('{"right":"no score"}')).toBeNull();
  expect(parseReview("plain prose, no json")).toBeNull();
  expect(parseReview(null)).toBeNull();
  expect(parseReview('{"score":0.5,"right":"use {x}","wrong":"","improve":""}')?.score).toBe(0.5); // brace in a string
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
