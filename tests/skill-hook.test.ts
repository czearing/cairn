import { test, expect, beforeEach } from "bun:test";
import { writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { extractRun } from "../src/skill/transcript";
import { skillsEnabled, skillInject, skillLearn, skillBlob } from "../src/skill/hook";
import { categorize, reindexSkill } from "../src/skill/match";
import { setMasterPrompt } from "../src/skill/store";
import { db } from "../src/core/db";

beforeEach(() => {
  try { db().run("DELETE FROM skills"); } catch { /* not created */ }
  try { db().run("DELETE FROM skill_runs"); } catch { /* not created */ }
});

test("extractRun scopes to the CURRENT turn, not the whole session", () => {
  const p = join(tmpdir(), `cairn-tx-${process.pid}.jsonl`);
  writeFileSync(p, [
    JSON.stringify({ type: "user", message: { content: "write me a haiku about frost" } }),
    JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "first frost on the gate" }] } }),
    JSON.stringify({ type: "user", message: { content: "make it sharper" } }),
    JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "the whole field holds still" }] } }),
  ].join("\n"));
  const run = extractRun(p);
  rmSync(p, { force: true });
  expect(run!.request).toBe("make it sharper");                       // latest turn's prompt, not the first
  expect(run!.output).toBe("the whole field holds still");
  expect(run!.transcript).toContain("[user] make it sharper");
  expect(run!.transcript).not.toContain("write me a haiku about frost"); // earlier turn excluded
});

test("extractRun excludes an earlier unrelated task (poem before haiku)", () => {
  const p = join(tmpdir(), `cairn-tx2-${process.pid}.jsonl`);
  writeFileSync(p, [
    JSON.stringify({ type: "user", message: { content: "write a poem" } }),
    JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "ROSES_ARE_RED_POEM" }] } }),
    JSON.stringify({ type: "user", message: { content: "write a haiku" } }),
    JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "SEVENTEEN_SYLLABLE_HAIKU" }] } }),
  ].join("\n"));
  const run = extractRun(p);
  rmSync(p, { force: true });
  expect(run!.request).toBe("write a haiku");
  expect(run!.output).toBe("SEVENTEEN_SYLLABLE_HAIKU");
  expect(run!.transcript).not.toContain("poem");                    // the poem task is not reviewed
  expect(run!.transcript).not.toContain("ROSES_ARE_RED_POEM");
});

test("extractRun batches successive user messages sent before a reply", () => {
  const p = join(tmpdir(), `cairn-tx3-${process.pid}.jsonl`);
  writeFileSync(p, [
    JSON.stringify({ type: "user", message: { content: "write a short story" } }),
    JSON.stringify({ type: "user", message: { content: "two paragraphs" } }),
    JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "THE_STORY" }] } }),
  ].join("\n"));
  const run = extractRun(p);
  rmSync(p, { force: true });
  expect(run!.request).toBe("write a short story\ntwo paragraphs"); // both successive prompts in one turn
  expect(run!.output).toBe("THE_STORY");
});

test("extractRun does not split a turn on a tool-result user message", () => {
  const p = join(tmpdir(), `cairn-tx4-${process.pid}.jsonl`);
  writeFileSync(p, [
    JSON.stringify({ type: "user", message: { content: "fix the bug" } }),
    JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "let me look" }] } }),
    JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", content: "file contents" }] } }),
    JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "fixed it" }] } }),
  ].join("\n"));
  const run = extractRun(p);
  rmSync(p, { force: true });
  expect(run!.request).toBe("fix the bug");                          // tool result is not a new turn
  expect(run!.output).toBe("fixed it");
});

test("extractRun returns null on an unreadable path", () => {
  expect(extractRun(join(tmpdir(), "does-not-exist-cairn.jsonl"))).toBeNull();
});

test("the skill layer is OFF by default, ON via CAIRN_SKILLS=1 (or the config flag)", () => {
  const prev = process.env.CAIRN_SKILLS;
  delete process.env.CAIRN_SKILLS;
  expect(skillsEnabled()).toBe(false);                      // default OFF (no env, no config flag in tests)
  process.env.CAIRN_SKILLS = "1";
  expect(skillsEnabled()).toBe(true);                       // explicit opt-in
  process.env.CAIRN_SKILLS = "0";
  expect(skillsEnabled()).toBe(false);                      // explicit opt-out
  expect(() => skillLearn("/some/path.jsonl")).not.toThrow(); // disabled -> no-op, never throws
  if (prev === undefined) delete process.env.CAIRN_SKILLS; else process.env.CAIRN_SKILLS = prev;
});

test("a 0-match injection records WHY (store count, embed status, top scores) so a bare 0 is diagnosable", async () => {
  const master = "1. imperative subject under 50 chars";
  const { skill } = await categorize("commit message", 1);
  setMasterPrompt(skill.id, master);
  await reindexSkill(skill.id, "commit message", master);
  const dbg = join(tmpdir(), `cairn-inj-${randomUUID()}.txt`);
  const prevFile = process.env.CAIRN_SKILL_DEBUG_FILE;
  process.env.CAIRN_SKILL_DEBUG_FILE = dbg;
  try {
    const out = await skillInject("qwerty zxcvbn asdf plugh"); // gibberish: matches nothing
    expect(out).toBe("");
    const logged = readFileSync(dbg, "utf8");
    expect(logged).toContain("matched 0 skills");
    expect(logged).toContain("WHY 0:");
    expect(logged).toContain("store=1 skills");                // store NOT empty -> rules out a wrong/empty db
    expect(logged).toMatch(/embed=ok\(dim \d+\)/);             // embed succeeded -> rules out an embed failure
  } finally {
    if (prevFile === undefined) delete process.env.CAIRN_SKILL_DEBUG_FILE; else process.env.CAIRN_SKILL_DEBUG_FILE = prevFile;
    try { rmSync(dbg); } catch { /* ignore */ }
  }
});

test("skillBlob piggyback: gated off, returns curated steps for a synonym query when on", async () => {
  const master = "imperative subject under 50 chars, explain what changed and why";
  const { skill } = await categorize("commit message", 1);
  setMasterPrompt(skill.id, master);
  await reindexSkill(skill.id, "commit message", master); // build the rich vector
  const prev = process.env.CAIRN_SKILLS;
  process.env.CAIRN_SKILLS = "0";
  expect(await skillBlob("how to write a good commit message")).toEqual([]); // explicit opt-out
  process.env.CAIRN_SKILLS = "1"; // explicit opt-in
  const blob = await skillBlob("how to write a good commit message");
  if (prev === undefined) delete process.env.CAIRN_SKILLS; else process.env.CAIRN_SKILLS = prev;
  expect(blob[0]!.task).toBe("commit message");
  expect(blob[0]!.steps).toContain("imperative subject");
});

test("the injection debug file is written BY DEFAULT (no env var needed), and CAIRN_SKILL_DEBUG=0 turns it off", async () => {
  const master = "1. imperative subject under 50 chars\n2. explain what changed and why";
  const { skill } = await categorize("commit message", 1);
  setMasterPrompt(skill.id, master);
  await reindexSkill(skill.id, "commit message", master);
  const dbg = join(tmpdir(), `cairn-inj-${randomUUID()}.txt`);
  const prevDebug = process.env.CAIRN_SKILL_DEBUG, prevFile = process.env.CAIRN_SKILL_DEBUG_FILE;
  delete process.env.CAIRN_SKILL_DEBUG;                           // default: no env var set at all
  process.env.CAIRN_SKILL_DEBUG_FILE = dbg;
  try {
    const out = await skillInject("how to write a good commit message");
    expect(out).toContain("imperative subject");                 // it injected the steps
    const logged = readFileSync(dbg, "utf8");
    expect(logged).toContain("matched 1 skill(s): commit message"); // header names the matched skill + score
    expect(logged).toContain("imperative subject");                 // the raw injected text is captured verbatim

    rmSync(dbg);
    process.env.CAIRN_SKILL_DEBUG = "0";                          // explicit opt-out: nothing written
    await skillInject("how to write a good commit message");
    expect(existsSync(dbg)).toBe(false);
  } finally {
    if (prevDebug === undefined) delete process.env.CAIRN_SKILL_DEBUG; else process.env.CAIRN_SKILL_DEBUG = prevDebug;
    if (prevFile === undefined) delete process.env.CAIRN_SKILL_DEBUG_FILE; else process.env.CAIRN_SKILL_DEBUG_FILE = prevFile;
    try { rmSync(dbg); } catch { /* ignore */ }
  }
});
