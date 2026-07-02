import { test, expect, beforeEach } from "bun:test";
import { reviewDeclared } from "../src/skill/pipeline";
import { getSkill, topRuns } from "../src/skill/store";
import { categorize } from "../src/skill/match";
import { db } from "../src/core/db";

beforeEach(() => {
  try { db().run("DELETE FROM skills"); } catch { /* not created */ }
  try { db().run("DELETE FROM skill_runs"); } catch { /* not created */ }
});

test("reviewDeclared grades the skill referenced BY ID -> learn -> store", async () => {
  const { skill } = await categorize("haiku", 1); // the agent created/found it first; skill_review carries its id
  const res = await reviewDeclared({ request: "write me a haiku about frost", transcript: "[user] frost\n[assistant] ok", output: "..." }, skill.id, 1, {
    learn: async () => ({ label: "haiku", review: { score: 0.8, right: "vivid", wrong: "flat ending", improve: "sharpen line 3", raw: "{}" }, master: "MASTER PROMPT V1", explanation: "RATIONALE V1" }),
  });
  expect(res).toMatchObject({ skillId: skill.id, task: "haiku", score: 0.8 });
  expect(getSkill(skill.id)!.masterPrompt).toBe("MASTER PROMPT V1"); // instructions rewritten and stored
  expect(getSkill(skill.id)!.explanation).toBe("RATIONALE V1");      // reviewer-only rationale stored separately
  const run = topRuns(skill.id)[0]!;
  expect(run.quality).toBe(0.8);
  expect(run.recipe).toBe("[user] frost\n[assistant] ok"); // the raw run transcript stored as the run's process
  expect(run.review).toContain("flat ending"); // verdict stored with the run
});

test("the AGENT's declared id routes to, and reuses, the right skill", async () => {
  const { skill: haiku } = await categorize("haiku", 1);
  const { skill: poem } = await categorize("poem", 1);
  const haikuLearn = async () => ({ label: "haiku", review: { score: 0.7, right: "", wrong: "", improve: "", raw: "" }, master: null, explanation: null });
  await reviewDeclared({ request: "a haiku", transcript: "x", output: "y" }, haiku.id, 1, { learn: haikuLearn });
  await reviewDeclared({ request: "a poem", transcript: "x", output: "y" }, poem.id, 2, { learn: async () => ({ label: "poem", review: { score: 0.6, right: "", wrong: "", improve: "", raw: "" }, master: null, explanation: null }) });
  await reviewDeclared({ request: "another haiku", transcript: "x", output: "y" }, haiku.id, 3, { learn: haikuLearn });
  expect(haiku.id).not.toBe(poem.id);          // distinct labels -> distinct skills, distinct ids
  expect(topRuns(haiku.id).length).toBe(2);    // same id reused, both runs land on the one skill
  expect(topRuns(poem.id).length).toBe(1);
});

test("a story turn and its review are TWO skill_review calls, landing under two skills", async () => {
  // The agent declares each deliverable separately (one skill_review per skill id); the reviewer never segments.
  const { skill: story } = await categorize("short story", 1);
  const { skill: review } = await categorize("short story review", 1);
  const labels: string[] = [];
  const learn = async (_req: string, _out: string, _tx: string, _ex: string[], _pr: unknown, _pm: string, _pe: string, forcedLabel: string) => {
    labels.push(forcedLabel);
    return { label: forcedLabel, review: { score: forcedLabel === "short story" ? 0.8 : 0.6, right: "", wrong: "", improve: "", raw: "" }, master: `${forcedLabel} MASTER`, explanation: "e" };
  };
  const a = await reviewDeclared({ request: "write a short story", transcript: "t", output: "the story" }, story.id, 1, { learn });
  const b = await reviewDeclared({ request: "write a short story", transcript: "t", output: "the critique" }, review.id, 1, { learn });
  expect([a!.task, b!.task].sort()).toEqual(["short story", "short story review"]); // two separate skills
  expect(getSkill(story.id)!.masterPrompt).toBe("short story MASTER");
  expect(getSkill(review.id)!.masterPrompt).toBe("short story review MASTER");
  expect(labels.sort()).toEqual(["short story", "short story review"]); // the learner is forced with each skill's OWN label, derived from its id
});

test("reviewDeclared returns null and stores nothing when the id is unknown", async () => {
  let learnCalled = false;
  const res = await reviewDeclared({ request: "thanks!", transcript: "x", output: "y" }, "no-such-id", 1, {
    learn: async () => { learnCalled = true; return { label: null, review: null, master: null, explanation: null }; },
  });
  expect(res).toBeNull();
  expect(learnCalled).toBe(false); // unknown id -> the learner is never called
});

test("a failed learner call is recorded as failed, stores nothing", async () => {
  const { skill } = await categorize("some skill", 1);
  const res = await reviewDeclared({ request: "real task", transcript: "x", output: "y" }, skill.id, 1, {
    learn: async () => ({ label: null, review: null, master: null, explanation: null, failed: true, error: "claude call failed" }),
  });
  expect(res).toBeNull();
  expect(topRuns(skill.id).length).toBe(0); // nothing stored on a failed learn
});
