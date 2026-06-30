import { test, expect, beforeEach } from "bun:test";
import { writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { extractRun } from "../src/skill/transcript";
import { skillsEnabled, skillInject, skillLearn, skillBlob, skillSearch, skillsExist } from "../src/skill/hook";
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
  expect(run!.output).toContain("fixed it");                         // deliverable = all assistant text of the turn
  expect(run!.output).toContain("let me look");                      // every assistant message, not just the last
});

test("extractRun keeps a mid-turn deliverable that is followed by end-of-turn bookkeeping", () => {
  // Regression: the short-story 0.10 bug. The agent wrote the story, then ended on brain bookkeeping, so the
  // last assistant message was bookkeeping. The graded output must still contain the story.
  const p = join(tmpdir(), `cairn-buried-${process.pid}.jsonl`);
  writeFileSync(p, [
    JSON.stringify({ type: "user", message: { content: "write me a short story" } }),
    JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "THE_POCKET_STORY: two laps in I have the pace exact" }] } }),
    JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Research graph bookkeeping: node c0f4e47f answered. The blocking reviewer is running." }] } }),
  ].join("\n"));
  const run = extractRun(p);
  rmSync(p, { force: true });
  expect(run!.output).toContain("THE_POCKET_STORY");                 // the story is graded, not lost behind bookkeeping
});

test("extractRun records timestamps and tool calls in the process transcript", () => {
  const p = join(tmpdir(), `cairn-ts-${process.pid}.jsonl`);
  writeFileSync(p, [
    JSON.stringify({ type: "user", timestamp: "2026-06-29T14:03:09.000Z", message: { content: "write me a haiku" } }),
    JSON.stringify({ type: "assistant", timestamp: "2026-06-29T14:03:12.500Z", message: { content: [{ type: "tool_use", name: "mcp__cairn__skill_search", input: { task: "haiku" } }] } }),
    JSON.stringify({ type: "assistant", timestamp: "2026-06-29T14:03:40.000Z", message: { content: [{ type: "text", text: "first frost on the gate" }] } }),
  ].join("\n"));
  const run = extractRun(p);
  rmSync(p, { force: true });
  expect(run!.transcript).toContain("14:03:09");                     // message timestamps are captured (HH:MM:SS)
  expect(run!.transcript).toContain("skill_search");                 // tool calls are captured, not stripped
  expect(run!.output).toBe("first frost on the gate");               // tool-only frame has no text, so output is the story
});

test("extractRun returns null on an unreadable path", () => {
  expect(extractRun(join(tmpdir(), "does-not-exist-cairn.jsonl"))).toBeNull();
});

test("extractRun ignores a host system-envelope user message so a notification never becomes the task", () => {
  // Genuine task, then a <task-notification> arrives as a user message. It must not open a new turn or pollute
  // the request, so the loop never grades a notification and mints a junk skill from it.
  const p = join(tmpdir(), `cairn-env-${process.pid}.jsonl`);
  writeFileSync(p, [
    JSON.stringify({ type: "user", message: { content: "ship the feature PR" } }),
    JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Pushed PR #42" }] } }),
    JSON.stringify({ type: "user", message: { content: "<task-notification> <task-id>b1</task-id> background job done" } }),
    JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Acknowledged" }] } }),
  ].join("\n"));
  const run = extractRun(p);
  rmSync(p, { force: true });
  expect(run!.request).toBe("ship the feature PR");        // anchored on the genuine prompt, not the notification
  expect(run!.request).not.toContain("task-notification");
});

test("extractRun returns null when the only user message is a system envelope (no human task)", () => {
  const p = join(tmpdir(), `cairn-env2-${process.pid}.jsonl`);
  writeFileSync(p, [
    JSON.stringify({ type: "user", message: { content: "<system_reminder> Custom instructions from AGENTS.md" } }),
    JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Noted." }] } }),
  ].join("\n"));
  const run = extractRun(p);
  rmSync(p, { force: true });
  expect(run).toBeNull();                                   // nothing the human asked for: skip learning
});

test("extractRun does not treat a tool-only assistant message as the output", () => {
  const p = join(tmpdir(), `cairn-toolonly-${process.pid}.jsonl`);
  writeFileSync(p, [
    JSON.stringify({ type: "user", message: { content: "write me a haiku about frost" } }),
    JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "mcp__cairn__brain_search", input: { query: "frost" } }] } }),
    JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "first frost on the gate" }] } }),
  ].join("\n"));
  const run = extractRun(p);
  rmSync(p, { force: true });
  expect(run!.output).toBe("first frost on the gate");    // the tool-only message is skipped
  expect(run!.request).toBe("write me a haiku about frost");
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

test("skillInject NO LONGER auto-injects a master (agent retrieves via skill_search), but still logs the match", async () => {
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
    expect(out).toBe("");                                          // nothing is auto-injected into the agent now
    const logged = readFileSync(dbg, "utf8");
    expect(logged).toContain("matched 1 skill(s): commit message"); // the cosine match is still recorded for diagnostics
    expect(logged).toContain("auto-injection disabled");            // and it is explicitly marked disabled

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

test("skill_search returns several candidate masters plus the catalog, so the agent disambiguates near-duplicates", async () => {
  const writer = await categorize("short story", 1); setMasterPrompt(writer.skill.id, "1. write a two-paragraph story");
  await reindexSkill(writer.skill.id, "short story", "1. write a two-paragraph story about a domain");
  const reviewer = await categorize("short story review", 2); setMasterPrompt(reviewer.skill.id, "1. score the story and name its weakest tells");
  await reindexSkill(reviewer.skill.id, "short story review", "1. score the story and name its weakest tells");
  const prev = process.env.CAIRN_SKILLS; process.env.CAIRN_SKILLS = "1";
  const res = await skillSearch("write a short story about a lighthouse");
  if (prev === undefined) delete process.env.CAIRN_SKILLS; else process.env.CAIRN_SKILLS = prev;
  const labels = res.matches.map((m) => m.task);
  expect(labels).toContain("short story");                         // the writer surfaces as a candidate...
  expect(labels).toContain("short story review");                  // ...alongside the near-duplicate, for the agent to pick
  expect(res.catalog.some((c) => c.startsWith("short story"))).toBe(true); // the full catalog rides along
});

test("skillsExist is false on an empty store, true once a skill exists (gates the search-first reminder)", async () => {
  const prev = process.env.CAIRN_SKILLS; process.env.CAIRN_SKILLS = "1";
  expect(skillsExist()).toBe(false);                               // nothing learned yet -> no reminder
  const { skill } = await categorize("haiku", 1); setMasterPrompt(skill.id, "1. count 5-7-5");
  await reindexSkill(skill.id, "haiku", "1. count 5-7-5");
  expect(skillsExist()).toBe(true);
  if (prev === undefined) delete process.env.CAIRN_SKILLS; else process.env.CAIRN_SKILLS = prev;
});
