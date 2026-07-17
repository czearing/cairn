import { test, expect, beforeEach } from "bun:test";
import { writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { extractRun } from "../src/skill/transcript";
import { skillsEnabled, skillCreate, skillInject, skillLearn, skillLoad, skillSearch, skillSelect, skillsExist } from "../src/skill/hook";
import { categorize, reindexSkill } from "../src/skill/match";
import { setMasterPrompt, setSkillMetadata } from "../src/skill/store";
import { db } from "../src/core/db";

beforeEach(() => {
  try { db().run("DELETE FROM skills"); } catch { /* not created */ }
  try { db().run("DELETE FROM skill_runs"); } catch { /* not created */ }
});

test("extractRun scopes the DETAIL to the current cycle (since the last skill_review)", () => {
  const p = join(tmpdir(), `cairn-tx-${process.pid}.jsonl`);
  writeFileSync(p, [
    JSON.stringify({ type: "user", message: { content: "write me a haiku about frost" } }),
    JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "first frost on the gate" }] } }),
    JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "skill_review", input: { label: "haiku" } }] } }), // cycle 1 closed
    JSON.stringify({ type: "user", message: { content: "make it sharper" } }),
    JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "the whole field holds still" }] } }),
    JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "skill_review", input: { label: "haiku" } }] } }), // cycle 2 = current
  ].join("\n"));
  const run = extractRun(p);
  rmSync(p, { force: true });
  expect(run!.request).toBe("make it sharper");                       // the CURRENT cycle's prompt
  expect(run!.output).toBe("the whole field holds still");
  expect(run!.transcript).toContain("[USER] make it sharper");
  expect(run!.transcript).not.toContain("write me a haiku about frost"); // earlier cycle excluded entirely
  expect(run!.transcript).toContain("TRANSCRIPT (oldest first):");
});

test("extractRun gives every back-to-back selected skill the same deliverable cycle", () => {
  const p = join(tmpdir(), `cairn-multi-review-${process.pid}.jsonl`);
  writeFileSync(p, [
    JSON.stringify({ type: "user", message: { content: "audit and test the lifecycle" } }),
    JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "FINAL DELIVERABLE" }] } }),
    JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "skill_review", input: { id: "skill-a" } }] } }),
    JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "skill_review", input: { id: "skill-b" } }] } }),
  ].join("\n"));
  expect(extractRun(p, "skill-a")?.output).toContain("FINAL DELIVERABLE");
  expect(extractRun(p, "skill-b")?.output).toContain("FINAL DELIVERABLE");
  rmSync(p, { force: true });
});

test("extractRun shows tool calls inline with their skill hint, timestamped (one transcript)", () => {
  const p = join(tmpdir(), `cairn-tx2-${process.pid}.jsonl`);
  writeFileSync(p, [
    JSON.stringify({ type: "user", timestamp: "2026-07-01T09:30:00.000Z", message: { content: "fix this PR description" } }),
    JSON.stringify({ type: "assistant", timestamp: "2026-07-01T09:30:05.000Z", message: { content: [{ type: "tool_use", name: "mcp__cairn__skill_search", input: { task: "pr description" } }] } }),
    JSON.stringify({ type: "assistant", timestamp: "2026-07-01T09:30:06.000Z", message: { content: [{ type: "tool_use", name: "mcp__cairn__skill_create", input: { label: "pr description" } }] } }),
    JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Rewrote the description." }] } }),
  ].join("\n"));
  const run = extractRun(p);
  rmSync(p, { force: true });
  expect(run!.transcript).toContain('[TOOL] skill_search "pr description"');
  expect(run!.transcript).toContain('[TOOL] skill_create "pr description"');
  expect(run!.transcript).toContain("[09:30:00] [USER] fix this PR description"); // timestamped user line
});

test("extractRun captures the model's THINKING blocks in the transcript", () => {
  const p = join(tmpdir(), `cairn-txt-${process.pid}.jsonl`);
  writeFileSync(p, [
    JSON.stringify({ type: "user", message: { content: "write me a haiku" } }),
    JSON.stringify({ type: "assistant", message: { content: [{ type: "thinking", thinking: "Ground it in a concrete winter image, avoid cliche." }, { type: "text", text: "first frost on the gate" }] } }),
  ].join("\n"));
  const run = extractRun(p);
  rmSync(p, { force: true });
  expect(run!.transcript).toContain("[ASSISTANT THINKING] Ground it in a concrete"); // thoughts captured
  expect(run!.transcript).toContain("[ASSISTANT] first frost on the gate");
  expect(run!.output).not.toContain("Ground it in a concrete"); // thinking is not the deliverable
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

test("extractRun latestTurn keeps a final deliverable after a system continuation", () => {
  const p = join(tmpdir(), `cairn-claude-continuation-${process.pid}.jsonl`);
  writeFileSync(p, [
    JSON.stringify({ type: "user", message: { content: "Complete both fixes." } }),
    JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Running final checks." }] } }),
    JSON.stringify({ type: "user", message: { content: "<system_notification>Shell completed.</system_notification>" } }),
    JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Both fixes are complete and live." }] } }),
  ].join("\n"));
  const run = extractRun(p, "", { latestTurn: true })!;
  rmSync(p, { force: true });
  expect(run.request).toBe("Complete both fixes.");
  expect(run.output).toContain("Both fixes are complete and live.");
  expect(run.transcript).not.toContain("system_notification");
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

test("the skill layer is ON by default, and CAIRN_SKILLS env overrides both ways", () => {
  const prev = process.env.CAIRN_SKILLS;
  delete process.env.CAIRN_SKILLS;
  expect(skillsEnabled()).toBe(true);                       // ON by default (no explicit opt-out)
  process.env.CAIRN_SKILLS = "1";
  expect(skillsEnabled()).toBe(true);                       // explicit opt-in
  process.env.CAIRN_SKILLS = "0";
  expect(skillsEnabled()).toBe(false);                      // explicit opt-out wins
  expect(() => skillLearn("/some/path.jsonl", "haiku")).not.toThrow(); // disabled -> no-op, never throws
  if (prev === undefined) delete process.env.CAIRN_SKILLS; else process.env.CAIRN_SKILLS = prev;
});

test("skill injection debug records catalog routing without semantic matching", async () => {
  const { skill } = await categorize("commit message", 1);
  setMasterPrompt(skill.id, "1. imperative subject under 50 chars");
  setSkillMetadata(skill.id, "commit message", "Use for writing concise commit messages that explain a reusable code change clearly.");
  const dbg = join(tmpdir(), `cairn-inj-${randomUUID()}.txt`);
  const prevFile = process.env.CAIRN_SKILL_DEBUG_FILE;
  process.env.CAIRN_SKILL_DEBUG_FILE = dbg;
  try {
    const out = await skillInject("qwerty zxcvbn asdf plugh");
    expect(out).toBe("");
    const logged = readFileSync(dbg, "utf8");
    expect(logged).toContain("catalog routing: 1 learned skill(s)");
    expect(logged).toContain("semantic routing disabled");
  } finally {
    if (prevFile === undefined) delete process.env.CAIRN_SKILL_DEBUG_FILE; else process.env.CAIRN_SKILL_DEBUG_FILE = prevFile;
    try { rmSync(dbg); } catch { /* ignore */ }
  }
});

test("skillInject does not auto-inject a master and can disable its catalog diagnostic", async () => {
  const master = "1. imperative subject under 50 chars\n2. explain what changed and why";
  const { skill } = await categorize("commit message", 1);
  setMasterPrompt(skill.id, master);
  setSkillMetadata(skill.id, "commit message", "Use for writing concise commit messages that explain a reusable code change clearly.");
  await reindexSkill(skill.id, "commit message", master);
  const dbg = join(tmpdir(), `cairn-inj-${randomUUID()}.txt`);
  const prevDebug = process.env.CAIRN_SKILL_DEBUG, prevFile = process.env.CAIRN_SKILL_DEBUG_FILE;
  delete process.env.CAIRN_SKILL_DEBUG;                           // default: no env var set at all
  process.env.CAIRN_SKILL_DEBUG_FILE = dbg;
  try {
    const out = await skillInject("how to write a good commit message");
    expect(out).toBe("");                                          // nothing is auto-injected into the agent now
    const logged = readFileSync(dbg, "utf8");
    expect(logged).toContain("catalog routing: 1 learned skill(s)");
    expect(logged).toContain("semantic routing disabled");

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

test("skill_search returns the same compact catalog for every query and skill_load fetches one exact master", async () => {
  const writer = await categorize("short story", 1); setMasterPrompt(writer.skill.id, "1. write a two-paragraph story");
  setSkillMetadata(writer.skill.id, "short story", "Use for writing two-paragraph stories and compact fictional scenes with a complete dramatic arc.");
  await reindexSkill(writer.skill.id, "short story", "1. write a two-paragraph story about a domain");
  const reviewer = await categorize("short story review", 2); setMasterPrompt(reviewer.skill.id, "1. score the story and name its weakest tells");
  setSkillMetadata(reviewer.skill.id, "short story review", "Use for reviewing short story drafts and fictional scenes to identify concrete revision priorities.");
  await reindexSkill(reviewer.skill.id, "short story review", "1. score the story and name its weakest tells");
  const prev = process.env.CAIRN_SKILLS; process.env.CAIRN_SKILLS = "1";
  const writing = skillSearch("write a short story about a lighthouse");
  const reviewing = skillSearch("review this story");
  if (prev === undefined) delete process.env.CAIRN_SKILLS; else process.env.CAIRN_SKILLS = prev;
  expect(writing.catalog).toEqual(reviewing.catalog);
  expect(writing.catalogVersion).toBe(reviewing.catalogVersion);
  expect(writing.catalog.map((entry) => entry.title)).toEqual(["short story", "short story review"]);
  expect(writing.catalog[0]!.description).toContain("two-paragraph stories");
  expect(skillLoad(writer.skill.id)?.steps).toContain("two-paragraph story");
  expect(skillLoad(reviewer.skill.id)?.steps).toContain("score the story");
  expect(skillSearch(`load:${writer.skill.id}`).loaded?.steps).toContain("two-paragraph story");
  expect(skillSearch("short story").matches?.[0]?.steps).toContain("two-paragraph story");
});

test("hidden retired skills cannot be loaded by exact legacy id", async () => {
  const retired = await categorize("retired test skill", 1);
  setMasterPrompt(retired.skill.id, "1. old test workflow");
  setSkillMetadata(retired.skill.id, "retired test skill", "");
  expect(skillLoad(retired.skill.id)).toBeNull();
  expect(skillSearch(`load:${retired.skill.id}`).loaded).toBeNull();
});

test("skill_select binds injected ids to the exact catalog version", async () => {
  const created = await categorize("cli troubleshooting", 1);
  setMasterPrompt(created.skill.id, "1. reproduce the CLI failure\n2. fix the earliest broken boundary");
  setSkillMetadata(created.skill.id, "cli troubleshooting", "Use for debugging CLI errors and local integration boundaries from exact evidence.");
  const injected = skillSearch("cli troubleshooting");

  expect(skillSelect([created.skill.id], "").error).toContain("catalogVersion is required");
  expect(skillSelect([created.skill.id], injected.catalogVersion).selected[0]?.id).toBe(created.skill.id);

  setMasterPrompt(created.skill.id, "1. reproduce\n2. trace\n3. verify");
  const stale = skillSelect([created.skill.id], injected.catalogVersion);
  expect(stale.error).toContain("stale skill catalog version");
  expect(stale.catalogVersion).not.toBe(injected.catalogVersion);
  expect(stale.currentCatalog?.some((skill) => skill.id === created.skill.id)).toBe(true);
});

test("skill_load rejects an unknown or pending skill", async () => {
  const pending = await categorize("pending skill", 1);
  expect(skillLoad(pending.skill.id)).toBeNull();
  expect(skillLoad("unknown")).toBeNull();
});

test("skill_create recovers an interrupted blank row and persists the initial plan", async () => {
  const pending = await categorize("api debugging", 1);
  const result = await skillCreate(
    "api debugging",
    "Use for diagnosing reusable API request, response, authentication, and server failures from exact evidence.",
    "1. Reproduce the failing request\n2. Trace the earliest incorrect boundary\n3. Verify the corrected response",
    "No injected catalog skill covers general API protocol debugging across repositories.",
  );
  expect(result).toMatchObject({ created: false, id: pending.skill.id });
  expect(skillLoad(pending.skill.id)?.steps).toContain("Reproduce the failing request");
});

test("skillsExist is false on an empty store, true once a skill exists (gates the search-first reminder)", async () => {
  const prev = process.env.CAIRN_SKILLS; process.env.CAIRN_SKILLS = "1";
  expect(skillsExist()).toBe(false);                               // nothing learned yet -> no reminder
  const { skill } = await categorize("haiku", 1); setMasterPrompt(skill.id, "1. count 5-7-5");
  setSkillMetadata(skill.id, "haiku", "Use for writing a haiku with deliberate imagery, form, sound, compression, and a clear turn.");
  await reindexSkill(skill.id, "haiku", "1. count 5-7-5");
  expect(skillsExist()).toBe(true);
  if (prev === undefined) delete process.env.CAIRN_SKILLS; else process.env.CAIRN_SKILLS = prev;
});
