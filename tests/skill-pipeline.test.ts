import { test, expect, beforeEach } from "bun:test";
import { reviewDeclared } from "../src/skill/pipeline";
import { skillByLabel, getSkill, topRuns } from "../src/skill/store";
import { db } from "../src/core/db";

beforeEach(() => {
  try { db().run("DELETE FROM skills"); } catch { /* not created */ }
  try { db().run("DELETE FROM skill_runs"); } catch { /* not created */ }
});

test("reviewDeclared grades the agent-declared label -> learn -> categorize (auto-create) -> store", async () => {
  const res = await reviewDeclared({ request: "write me a haiku about frost", transcript: "[user] frost\n[assistant] ok", output: "..." }, "haiku", "the frost haiku", 1, {
    learn: async () => ({ label: "haiku", review: { score: 0.8, right: "vivid", wrong: "flat ending", improve: "sharpen line 3", raw: "{}" }, master: "MASTER PROMPT V1", explanation: "RATIONALE V1" }),
  });
  expect(res).toMatchObject({ task: "haiku", score: 0.8, created: true }); // the skill was auto-created
  const skill = skillByLabel("haiku")!;
  expect(getSkill(skill.id)!.masterPrompt).toBe("MASTER PROMPT V1"); // instructions rewritten and stored
  expect(getSkill(skill.id)!.explanation).toBe("RATIONALE V1");      // reviewer-only rationale stored separately
  const run = topRuns(skill.id)[0]!;
  expect(run.quality).toBe(0.8);
  expect(run.recipe).toBe("[user] frost\n[assistant] ok"); // the raw run transcript stored as the run's process
  expect(run.review).toContain("flat ending"); // verdict stored with the run
});

test("the AGENT's declared label routes to, and reuses, the right skill", async () => {
  const haikuLearn = async () => ({ label: "haiku", review: { score: 0.7, right: "", wrong: "", improve: "", raw: "" }, master: null, explanation: null });
  await reviewDeclared({ request: "a haiku", transcript: "x", output: "y" }, "haiku", "", 1, { learn: haikuLearn });
  await reviewDeclared({ request: "a poem", transcript: "x", output: "y" }, "poem", "", 2, { learn: async () => ({ label: "poem", review: { score: 0.6, right: "", wrong: "", improve: "", raw: "" }, master: null, explanation: null }) });
  await reviewDeclared({ request: "another haiku", transcript: "x", output: "y" }, "haiku", "", 3, { learn: haikuLearn });
  expect(skillByLabel("haiku")!.id).not.toBe(skillByLabel("poem")!.id); // distinct labels -> distinct skills
  expect(topRuns(skillByLabel("haiku")!.id).length).toBe(2);           // same label reused, no duplicate skill
});

test("a story turn and its review are TWO skill_review calls, landing under two skills", async () => {
  // The agent declares each deliverable separately (one skill_review per label); the reviewer never segments.
  const focuses: string[] = [];
  const learn = async (_req: string, _out: string, _tx: string, _ex: string[], _pr: unknown, _pm: string, _pe: string, forcedLabel: string, focus: string) => {
    focuses.push(focus);
    return { label: forcedLabel, review: { score: forcedLabel === "short story" ? 0.8 : 0.6, right: "", wrong: "", improve: "", raw: "" }, master: `${forcedLabel} MASTER`, explanation: "e" };
  };
  const a = await reviewDeclared({ request: "write a short story", transcript: "t", output: "the story" }, "short story", "the story about the lighthouse", 1, { learn });
  const b = await reviewDeclared({ request: "write a short story", transcript: "t", output: "the critique" }, "short story review", "the reviewer's critique", 1, { learn });
  expect([a!.task, b!.task].sort()).toEqual(["short story", "short story review"]); // two separate skills
  expect(skillByLabel("short story")!.masterPrompt).toBe("short story MASTER");
  expect(skillByLabel("short story review")!.masterPrompt).toBe("short story review MASTER");
  expect(focuses).toContain("the reviewer's critique"); // focus names which deliverable to grade
});

test("reviewDeclared returns null and stores nothing when there is no declared label", async () => {
  let learnCalled = false;
  const res = await reviewDeclared({ request: "thanks!", transcript: "x", output: "y" }, "", "", 1, {
    learn: async () => { learnCalled = true; return { label: null, review: null, master: null, explanation: null }; },
  });
  expect(res).toBeNull();
  expect(learnCalled).toBe(false); // no label -> the learner is never called
});

test("a failed learner call is recorded as failed, stores nothing", async () => {
  const res = await reviewDeclared({ request: "real task", transcript: "x", output: "y" }, "some skill", "", 1, {
    learn: async () => ({ label: null, review: null, master: null, explanation: null, failed: true, error: "claude call failed" }),
  });
  expect(res).toBeNull();
  expect(skillByLabel("some skill")).toBeNull(); // nothing stored on a failed learn
});
