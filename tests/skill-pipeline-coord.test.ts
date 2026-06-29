import { test, expect, beforeEach } from "bun:test";
import { rmSync, mkdirSync } from "node:fs";
import { db } from "../src/core/db";
import { registerInflight, markReady } from "../src/skill/coordinate";
import { processRunCoordinated } from "../src/skill/pipeline";
import { categorize } from "../src/skill/match";
import { setMasterPrompt, getSkill, topRuns, skillByLabel } from "../src/skill/store";
import type { LearnResult } from "../src/skill/reviewer";

const DIR = process.env.CAIRN_INFLIGHT_DIR!;
beforeEach(() => {
  try { db().run("DELETE FROM skills"); } catch { /* not created */ }
  try { db().run("DELETE FROM skill_runs"); } catch { /* not created */ }
  try { rmSync(DIR, { recursive: true, force: true }); } catch { /* none */ }
  mkdirSync(DIR, { recursive: true });
});

test("processRunCoordinated coalesces two peers into ONE review and updates the master once", async () => {
  const now = Date.now(); // coordinatedReview uses the real clock, so the run timestamps must be real-time too
  const { skill } = await categorize("haiku", now);   // the skill already exists (it was injected into both windows)
  setMasterPrompt(skill.id, "old master");

  registerInflight("A", "haiku", now);
  registerInflight("B", "haiku", now);
  markReady("A", "haiku", "haiku A", "tx A", now);
  markReady("B", "haiku", "haiku B", "tx B", now);    // both windows finished

  let sawRuns = 0;
  let sawPriorMaster = "";
  const reviewMany = async (_req: string, runs: { output: string; transcript: string }[], _ex: string[], _pr: unknown, priorMaster: string): Promise<LearnResult> => {
    sawRuns = runs.length;
    sawPriorMaster = priorMaster;
    return { label: "haiku", review: { score: 0.8, right: "r", wrong: "w", improve: "i", raw: "" }, master: "new master", explanation: "new rationale" };
  };

  const classify = async () => ({ label: "haiku", failed: false });
  const res = await processRunCoordinated({ request: "write a haiku", output: "haiku A", transcript: "tx A" }, "A", now, { classify, reviewMany });

  expect(sawRuns).toBe(2);                                      // ONE review saw BOTH concurrent runs
  expect(sawPriorMaster).toBe("old master");                    // the reviewer received the skill's current master
  expect(res[0]?.task).toBe("haiku");
  expect(res[0]?.score).toBe(0.8);
  expect(getSkill(skill.id)?.masterPrompt).toBe("new master");  // master updated exactly once
  expect(getSkill(skill.id)?.explanation).toBe("new rationale"); // reviewer-only rationale updated too
  expect(topRuns(skill.id, 10).length).toBe(2);                 // one run recorded per coalesced session
});

test("the coordinated write follows the LEARNER's label, not the injected skill (a debug turn that injected 'short story' learns under 'debugging')", async () => {
  const now = Date.now();
  const { skill: story } = await categorize("short story", now);  // the skill the turn happened to inject/match
  setMasterPrompt(story.id, "STORY MASTER", "story why");

  registerInflight("S", "short story", now);                      // session injected/registered "short story"
  markReady("S", "short story", "out", "tx", now);

  // The unanchored CLASSIFIER reads the actual deliverable and labels it "debugging", NOT "short story".
  const classify = async () => ({ label: "debugging", failed: false });
  const reviewMany = async (): Promise<LearnResult> =>
    ({ label: "debugging", review: { score: 0.7, right: "r", wrong: "w", improve: "i", raw: "" }, master: "DEBUG MASTER", explanation: "debug why" });

  const res = await processRunCoordinated({ request: "why did the skill get mislabeled", output: "db queries and a fix", transcript: "tx" }, "S", now, { classify, reviewMany });

  expect(res[0]?.task).toBe("debugging");                          // routed by the label
  expect(skillByLabel("debugging")?.masterPrompt).toBe("DEBUG MASTER"); // learning landed on the right skill
  expect(getSkill(story.id)?.masterPrompt).toBe("STORY MASTER");   // the injected story skill was NOT touched
  expect(skillByLabel("short story 2")).toBeNull();                // and NOT split into a story variant
});

test("processRunCoordinated does nothing for a session with no injected skill (cold task path handled by solo processRun)", async () => {
  const now = 6_000_000;
  const { sessionSkill } = await import("../src/skill/coordinate");
  expect(sessionSkill("never-registered")).toBeNull();          // a cold task has no in-flight skill, so it routes to solo processRun
});
