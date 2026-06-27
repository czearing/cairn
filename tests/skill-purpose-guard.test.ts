import { test, expect, beforeEach } from "bun:test";
import { processRun } from "../src/skill/pipeline";
import { skillByLabel, getSkill, skillIdentityVector } from "../src/skill/store";
import type { LearnResult } from "../src/skill/reviewer";
import { db } from "../src/core/db";

beforeEach(() => {
  try { db().run("DELETE FROM skills"); } catch { /* not created */ }
  try { db().run("DELETE FROM skill_runs"); } catch { /* not created */ }
});

// A learner mock that always assigns `label` and rewrites the master to `master`.
const learner = (label: string, master: string): LearnResult =>
  ({ label, review: { score: 0.8, right: "r", wrong: "w", improve: "i", raw: "" }, master, explanation: "why" });

const PR_REQ = "monitor my Azure PR and ping me when the builds pass";
const AUDIO_REQ = "A/B the forest track with the selected reference and compare LUFS and true peak";
const HAIKU_1 = "write me a haiku about frost";
const HAIKU_2 = "compose a haiku about the sea at dawn";

test("an off-purpose run that reused a label is routed to a variant, leaving the original master intact", async () => {
  // Seed: a real PR-monitor run forms the skill and freezes its identity to the PR request.
  await processRun({ request: PR_REQ, transcript: "t", output: "o" }, 1, { match: async () => null, learn: async () => learner("pr monitor", "PR MASTER") });
  const pr = skillByLabel("pr monitor")!;
  expect(getSkill(pr.id)!.masterPrompt).toBe("PR MASTER");

  // An audio A/B run whose learner WRONGLY labels it "pr monitor". The guard sees the audio request is far
  // from the frozen PR identity and routes it to a new variant instead of clobbering "pr monitor".
  const res = await processRun({ request: AUDIO_REQ, transcript: "t", output: "o" }, 2, { match: async () => null, learn: async () => learner("pr monitor", "AUDIO MASTER") });

  expect(getSkill(pr.id)!.masterPrompt).toBe("PR MASTER");        // original skill NOT clobbered
  expect(res[0]!.task).toBe("pr monitor (2)");                    // routed to a variant
  const variant = skillByLabel("pr monitor 2")!;                  // normalized form of "pr monitor (2)"
  expect(variant).toBeTruthy();
  expect(getSkill(variant.id)!.masterPrompt).toBe("AUDIO MASTER");
});

test("a second on-purpose request reuses the same skill, with no variant created", async () => {
  await processRun({ request: HAIKU_1, transcript: "t", output: "o" }, 1, { match: async () => null, learn: async () => learner("haiku", "HAIKU V1") });
  const haiku = skillByLabel("haiku")!;

  const res = await processRun({ request: HAIKU_2, transcript: "t", output: "o" }, 2, { match: async () => null, learn: async () => learner("haiku", "HAIKU V2") });

  expect(res[0]!.task).toBe("haiku");                             // same skill, no fork
  expect(getSkill(haiku.id)!.masterPrompt).toBe("HAIKU V2");      // refinement applied
  expect(skillByLabel("haiku 2")).toBeNull();                    // no variant minted for a legit refinement
});

test("identity is frozen on the first write and not overwritten by a later same-purpose run", async () => {
  await processRun({ request: HAIKU_1, transcript: "t", output: "o" }, 1, { match: async () => null, learn: async () => learner("haiku", "HAIKU V1") });
  const haiku = skillByLabel("haiku")!;
  const idV1 = skillIdentityVector(haiku.id);
  expect(idV1.length).toBeGreaterThan(0);

  await processRun({ request: HAIKU_2, transcript: "t", output: "o" }, 2, { match: async () => null, learn: async () => learner("haiku", "HAIKU V2") });
  const idV2 = skillIdentityVector(haiku.id);
  expect(idV2).toEqual(idV1);                                     // unchanged: the identity is frozen, never drifts
});
