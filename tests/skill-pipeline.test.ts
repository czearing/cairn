import { test, expect, beforeEach } from "bun:test";
import { processRun } from "../src/skill/pipeline";
import { skillByLabel, getSkill, topRuns } from "../src/skill/store";
import { db } from "../src/core/db";

beforeEach(() => {
  try { db().run("DELETE FROM skills"); } catch { /* not created */ }
  try { db().run("DELETE FROM skill_runs"); } catch { /* not created */ }
});

test("processRun wires segment -> learn (grade + master) -> categorize -> store", async () => {
  const res = await processRun({ request: "write me a haiku about frost", transcript: "[user] frost\n[assistant] ok", output: "..." }, 1, {
    segment: async () => ({ deliverables: [{ label: "haiku", what: "the frost haiku" }], failed: false }),
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

test("the SEGMENTER's label (not the learner's) routes to, and reuses, the right skill", async () => {
  const haikuLearn = async () => ({ label: "haiku", review: { score: 0.7, right: "", wrong: "", improve: "", raw: "" }, master: null, explanation: null });
  const haikuSeg = async () => ({ deliverables: [{ label: "haiku", what: "" }], failed: false });
  await processRun({ request: "a haiku", transcript: "x", output: "y" }, 1, { segment: haikuSeg, learn: haikuLearn });
  await processRun({ request: "a poem", transcript: "x", output: "y" }, 2, { segment: async () => ({ deliverables: [{ label: "poem", what: "" }], failed: false }), learn: async () => ({ label: "poem", review: { score: 0.6, right: "", wrong: "", improve: "", raw: "" }, master: null, explanation: null }) });
  await processRun({ request: "another haiku", transcript: "x", output: "y" }, 3, { segment: haikuSeg, learn: haikuLearn });
  expect(skillByLabel("haiku")!.id).not.toBe(skillByLabel("poem")!.id); // distinct labels -> distinct skills
  expect(topRuns(skillByLabel("haiku")!.id).length).toBe(2);           // same label reused, no duplicate skill
});

test("a story turn that also reviews itself yields a short story AND a short story review run", async () => {
  const focuses: string[] = [];
  const res = await processRun({ request: "write a short story", transcript: "t", output: "the story then a critique of it" }, 1, {
    // The reviewing agent segments the one turn into its TWO distinct deliverables.
    segment: async () => ({ deliverables: [{ label: "short story", what: "the story about the lighthouse" }, { label: "short story review", what: "the reviewer subagent's critique" }], failed: false }),
    learn: async (_req, _out, _tx, _ex, _pr, _pm, _pe, forcedLabel, focus) => {
      focuses.push(focus);
      return { label: forcedLabel, review: { score: forcedLabel === "short story" ? 0.8 : 0.6, right: "", wrong: "", improve: "", raw: "" }, master: `${forcedLabel} MASTER`, explanation: "e" };
    },
  });
  expect(res.map((r) => r.task).sort()).toEqual(["short story", "short story review"]); // two separate skills
  expect(skillByLabel("short story")).not.toBeNull();
  expect(skillByLabel("short story review")).not.toBeNull();
  expect(skillByLabel("short story")!.masterPrompt).toBe("short story MASTER");
  expect(skillByLabel("short story review")!.masterPrompt).toBe("short story review MASTER");
  expect(focuses).toContain("the reviewer subagent's critique"); // focus names which deliverable to grade
});

test("processRun returns [] and never grades when the turn has no deliverable (non-task)", async () => {
  let learnCalled = false;
  const res = await processRun({ request: "thanks, that's great!", transcript: "x", output: "y" }, 1, {
    segment: async () => ({ deliverables: [], failed: false }), // non-task: empty list short-circuits before learn
    learn: async () => { learnCalled = true; return { label: null, review: null, master: null, explanation: null }; },
  });
  expect(res).toEqual([]);
  expect(learnCalled).toBe(false);                         // STAGE 2 is never reached for a non-task
  expect(skillByLabel("thanks that s great")).toBeNull();
});

test("the segmenter always decides the labels (the doer never declares one)", async () => {
  let segCalled = false;
  const res = await processRun({ request: "write about a lighthouse", transcript: "t", output: "a story" }, 1, {
    segment: async () => { segCalled = true; return { deliverables: [{ label: "short story", what: "the story" }], failed: false }; },
    learn: async () => ({ label: "short story", review: { score: 0.8, right: "", wrong: "", improve: "", raw: "" }, master: "STORY MASTER", explanation: "why" }),
  });
  expect(segCalled).toBe(true);                            // labeling is the loop's job, run every time
  expect(res[0]!.task).toBe("short story");                // routed by the segmenter's label
  expect(skillByLabel("short story")!.masterPrompt).toBe("STORY MASTER");
});

test("a failed segment call is recorded as failed, not a non-task", async () => {
  const res = await processRun({ request: "real task", transcript: "x", output: "y" }, 1, {
    segment: async () => ({ deliverables: [], failed: true, error: "claude call failed" }),
    learn: async () => ({ label: "x", review: { score: 0.5, right: "", wrong: "", improve: "", raw: "" }, master: "m", explanation: "e" }),
  });
  expect(res).toEqual([]);                                  // nothing stored on a failed segment
});
