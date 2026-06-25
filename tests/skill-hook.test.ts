import { test, expect, beforeEach } from "bun:test";
import { writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { extractRun } from "../src/skill/transcript";
import { skillsEnabled, skillInject, skillLearn, skillBlob } from "../src/skill/hook";
import { categorize, reindexSkill } from "../src/skill/match";
import { setMasterPrompt } from "../src/skill/store";
import { db } from "../src/core/db";

beforeEach(() => {
  try { db().run("DELETE FROM skills"); } catch { /* not created */ }
  try { db().run("DELETE FROM skill_runs"); } catch { /* not created */ }
});

test("extractRun pulls request (first user) and output (last assistant) from a transcript", () => {
  const p = join(tmpdir(), `cairn-tx-${process.pid}.jsonl`);
  writeFileSync(p, [
    JSON.stringify({ type: "user", message: { content: "write me a haiku about frost" } }),
    JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "first frost on the gate" }] } }),
    JSON.stringify({ type: "user", message: { content: "make it sharper" } }),
    JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "the whole field holds still" }] } }),
  ].join("\n"));
  const run = extractRun(p);
  rmSync(p, { force: true });
  expect(run!.request).toBe("write me a haiku about frost");
  expect(run!.output).toBe("the whole field holds still");
  expect(run!.transcript).toContain("[user] write me a haiku about frost");
});

test("extractRun returns null on an unreadable path", () => {
  expect(extractRun(join(tmpdir(), "does-not-exist-cairn.jsonl"))).toBeNull();
});

test("the skill layer is ON by default and OFF when CAIRN_SKILLS=0", () => {
  const prev = process.env.CAIRN_SKILLS;
  delete process.env.CAIRN_SKILLS;
  expect(skillsEnabled()).toBe(true);                       // default on
  process.env.CAIRN_SKILLS = "0";
  expect(skillsEnabled()).toBe(false);                      // explicit opt-out
  expect(() => skillLearn("/some/path.jsonl")).not.toThrow(); // disabled -> no-op, never throws
  if (prev === undefined) delete process.env.CAIRN_SKILLS; else process.env.CAIRN_SKILLS = prev;
});

test("skillBlob piggyback: gated off, returns curated steps for a synonym query when on", async () => {
  const master = "imperative subject under 50 chars, explain what changed and why";
  const { skill } = await categorize("commit message", 1);
  setMasterPrompt(skill.id, master);
  await reindexSkill(skill.id, "commit message", master); // build the rich vector
  const prev = process.env.CAIRN_SKILLS;
  process.env.CAIRN_SKILLS = "0";
  expect(await skillBlob("how to write a good commit message")).toEqual([]); // explicit off
  delete process.env.CAIRN_SKILLS; // default on
  const blob = await skillBlob("how to write a good commit message");
  if (prev === undefined) delete process.env.CAIRN_SKILLS; else process.env.CAIRN_SKILLS = prev;
  expect(blob[0]!.task).toBe("commit message");
  expect(blob[0]!.steps).toContain("imperative subject");
});
