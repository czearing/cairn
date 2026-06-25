import { test, expect, beforeEach } from "bun:test";
import { parseTable } from "../src/skill/compact";
import { parseLabels } from "../src/skill/label";
import { parseReview } from "../src/skill/reviewer";
import { normalizeLabel, categorize } from "../src/skill/match";
import { putSkill } from "../src/skill/store";
import { db } from "../src/core/db";

beforeEach(() => {
  try { db().run("DELETE FROM skills"); } catch { /* not created */ }
  try { db().run("DELETE FROM skill_runs"); } catch { /* not created */ }
});

// ---- parser hostility: a consumer LLM returns messy output; nothing should crash or yield garbage ----

test("parseTable: header-only, ragged, empty, and CRLF inputs", () => {
  expect(parseTable("| timestamp | step | result |\n|---|---|---|")).toEqual([]); // header + separator only
  expect(parseTable("| a | b |\n| a | b | c | d |")).toEqual([]);                  // wrong column counts
  expect(parseTable("")).toEqual([]);
  expect(parseTable("| 00:01 | draft | ok |\r\n")).toEqual([{ timestamp: "00:01", step: "draft", result: "ok" }]); // \r stripped
});

test("parseLabels: bullets, numbering, code fences, and pure punctuation never become labels", () => {
  expect(parseLabels("```\n- Haiku\n2) Poem\n```")).toEqual(["haiku", "poem"]); // fences and bullets dropped
  expect(parseLabels("***\n---\n`")).toEqual([]);                                 // pure punctuation -> nothing
  expect(parseLabels("haiku\nhaiku\nHAIKU")).toEqual(["haiku"]);                  // dedupe + case
});

test("parseLabels drops echoed prompt scaffolding (<request> tags)", () => {
  expect(parseLabels("<request>\npoem\nhaiku\n</request>")).toEqual(["poem", "haiku"]);
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
