import { test, expect, beforeEach } from "bun:test";
import { processRun } from "../src/skill/pipeline";
import { skillByLabel, getSkill, topRuns } from "../src/skill/store";
import { db } from "../src/core/db";

beforeEach(() => {
  try { db().run("DELETE FROM skills"); } catch { /* not created */ }
  try { db().run("DELETE FROM skill_runs"); } catch { /* not created */ }
});

test("processRun wires match -> learn (label + grade + master) -> categorize -> store", async () => {
  const res = await processRun({ request: "write me a haiku about frost", transcript: "[user] frost\n[assistant] ok", output: "..." }, 1, {
    match: async () => null,
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

test("the learner's label routes to, and reuses, the right skill", async () => {
  const haikuLearn = async () => ({ label: "haiku", review: { score: 0.7, right: "", wrong: "", improve: "", raw: "" }, master: null, explanation: null });
  await processRun({ request: "a haiku", transcript: "x", output: "y" }, 1, { match: async () => null, learn: haikuLearn });
  await processRun({ request: "a poem", transcript: "x", output: "y" }, 2, { match: async () => null, learn: async () => ({ label: "poem", review: { score: 0.6, right: "", wrong: "", improve: "", raw: "" }, master: null, explanation: null }) });
  await processRun({ request: "another haiku", transcript: "x", output: "y" }, 3, { match: async () => null, learn: haikuLearn });
  expect(skillByLabel("haiku")!.id).not.toBe(skillByLabel("poem")!.id); // distinct labels -> distinct skills
  expect(topRuns(skillByLabel("haiku")!.id).length).toBe(2);           // same label reused, no duplicate skill
});

test("processRun returns [] and creates no skill when the learner gives no label", async () => {
  const res = await processRun({ request: "thanks, that's great!", transcript: "x", output: "y" }, 1, {
    match: async () => null,
    learn: async () => ({ label: null, review: null, master: null, explanation: null }), // non-task or failed call
  });
  expect(res).toEqual([]);
  expect(skillByLabel("thanks that s great")).toBeNull();
});
