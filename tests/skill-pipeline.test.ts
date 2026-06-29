import { test, expect, beforeEach } from "bun:test";
import { processRun } from "../src/skill/pipeline";
import { skillByLabel, getSkill, topRuns } from "../src/skill/store";
import { db } from "../src/core/db";

beforeEach(() => {
  try { db().run("DELETE FROM skills"); } catch { /* not created */ }
  try { db().run("DELETE FROM skill_runs"); } catch { /* not created */ }
});

test("processRun wires classify -> learn (grade + master) -> categorize -> store", async () => {
  const res = await processRun({ request: "write me a haiku about frost", transcript: "[user] frost\n[assistant] ok", output: "..." }, 1, {
    classify: async () => ({ label: "haiku", failed: false }),
    learn: async () => ({ label: "haiku", review: { score: 0.8, right: "vivid", wrong: "flat ending", improve: "sharpen line 3", raw: "{}" }, master: "MASTER PROMPT V1", explanation: "RATIONALE V1" }),
  });
  expect(res[0]).toMatchObject({ task: "haiku", score: 0.8, created: true });
  const skill = skillByLabel("haiku")!;
  expect(getSkill(skill.id)!.masterPrompt).toBe("MASTER PROMPT V1"); // instructions rewritten and stored
  expect(getSkill(skill.id)!.explanation).toBe("RATIONALE V1");      // reviewer-only rationale stored separately
  const run = topRuns(skill.id)[0]!;
  expect(run.quality).toBe(0.8);
  expect(run.recipe).toBe("[user] frost\n[assistant] ok"); // the raw run transcript stored as the run's process
  expect(run.review).toContain("flat ending"); // verdict stored with the run
});

test("the CLASSIFIER's label (not the learner's) routes to, and reuses, the right skill", async () => {
  const haikuLearn = async () => ({ label: "haiku", review: { score: 0.7, right: "", wrong: "", improve: "", raw: "" }, master: null, explanation: null });
  const haikuClassify = async () => ({ label: "haiku", failed: false });
  await processRun({ request: "a haiku", transcript: "x", output: "y" }, 1, { classify: haikuClassify, learn: haikuLearn });
  await processRun({ request: "a poem", transcript: "x", output: "y" }, 2, { classify: async () => ({ label: "poem", failed: false }), learn: async () => ({ label: "poem", review: { score: 0.6, right: "", wrong: "", improve: "", raw: "" }, master: null, explanation: null }) });
  await processRun({ request: "another haiku", transcript: "x", output: "y" }, 3, { classify: haikuClassify, learn: haikuLearn });
  expect(skillByLabel("haiku")!.id).not.toBe(skillByLabel("poem")!.id); // distinct labels -> distinct skills
  expect(topRuns(skillByLabel("haiku")!.id).length).toBe(2);           // same label reused, no duplicate skill
});

test("processRun returns [] and creates no skill when the classifier gives no label (non-task)", async () => {
  let learnCalled = false;
  const res = await processRun({ request: "thanks, that's great!", transcript: "x", output: "y" }, 1, {
    classify: async () => ({ label: "", failed: false }), // non-task: empty label, short-circuits before learn
    learn: async () => { learnCalled = true; return { label: null, review: null, master: null, explanation: null }; },
  });
  expect(res).toEqual([]);
  expect(learnCalled).toBe(false);                         // STAGE 2 is never reached for a non-task
  expect(skillByLabel("thanks that s great")).toBeNull();
});

test("a declared label (skill_use) skips the classifier and routes to that skill", async () => {
  let classifyCalled = false;
  const res = await processRun({ request: "write about a lighthouse", transcript: "t", output: "a story", declaredLabel: "short story" }, 1, {
    classify: async () => { classifyCalled = true; return { label: "short story review", failed: false }; }, // would mispick
    learn: async () => ({ label: "short story", review: { score: 0.8, right: "", wrong: "", improve: "", raw: "" }, master: "STORY MASTER", explanation: "why" }),
  });
  expect(classifyCalled).toBe(false);                       // the agent's pick is trusted; no classify LLM call
  expect(res[0]!.task).toBe("short story");                 // routed by the declared label, not the classifier
  expect(skillByLabel("short story")!.masterPrompt).toBe("STORY MASTER");
});

test("a failed classify call is recorded as failed, not a non-task", async () => {
  const res = await processRun({ request: "real task", transcript: "x", output: "y" }, 1, {
    classify: async () => ({ label: "", failed: true, error: "claude call failed" }),
    learn: async () => ({ label: "x", review: { score: 0.5, right: "", wrong: "", improve: "", raw: "" }, master: "m", explanation: "e" }),
  });
  expect(res).toEqual([]);                                  // nothing stored on a failed classify
});
