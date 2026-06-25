import { test, expect, beforeEach } from "bun:test";
import { processRun } from "../src/skill/pipeline";
import { skillByLabel, getSkill, topRuns } from "../src/skill/store";
import { db } from "../src/core/db";

beforeEach(() => {
  try { db().run("DELETE FROM skills"); } catch { /* not created */ }
  try { db().run("DELETE FROM skill_runs"); } catch { /* not created */ }
});

test("processRun wires label -> categorize -> compact -> review -> store -> assemble", async () => {
  const res = await processRun({ request: "write me a haiku about frost", transcript: "...", output: "..." }, 1, {
    label: async () => ["haiku"],
    compact: async () => ({ raw: "| t | s | r |" }),
    review: async () => ({ score: 0.8, right: "vivid", wrong: "flat ending", improve: "sharpen line 3", raw: "{}" }),
    assemble: async () => "MASTER PROMPT V1",
  });
  expect(res[0]).toMatchObject({ task: "haiku", score: 0.8, created: true });
  const skill = skillByLabel("haiku")!;
  expect(getSkill(skill.id)!.masterPrompt).toBe("MASTER PROMPT V1"); // master assembled and stored
  const run = topRuns(skill.id)[0]!;
  expect(run.quality).toBe(0.8);
  expect(run.recipe).toBe("| t | s | r |");      // compacted recipe stored
  expect(run.review).toContain("flat ending");    // reviewer verdict stored with the run
});

test("processRun processes multiple skills serially into distinct skills", async () => {
  const res = await processRun({ request: "a haiku and a poem", transcript: "x", output: "y" }, 1, {
    label: async () => ["haiku", "poem"],
    compact: async () => ({ raw: "table" }),
    review: async (_s, t) => ({ score: t === "haiku" ? 0.7 : 0.6, right: "", wrong: "", improve: "", raw: "" }),
    assemble: async () => null,
  });
  expect(res.map((r) => r.task)).toEqual(["haiku", "poem"]);
  expect(skillByLabel("haiku")!.id).not.toBe(skillByLabel("poem")!.id);
  expect(topRuns(skillByLabel("haiku")!.id)[0]!.quality).toBe(0.7);
});

test("processRun stores an ungraded run when the reviewer fails, never throws", async () => {
  const res = await processRun({ request: "haiku", transcript: "x", output: "y" }, 1, {
    label: async () => ["haiku"],
    compact: async () => ({ raw: "t" }),
    review: async () => null,        // reviewer unavailable
    assemble: async () => null,
  });
  expect(res[0]!.score).toBe(0);
  expect(topRuns(skillByLabel("haiku")!.id)[0]!.quality).toBe(0); // run still recorded
});

test("processRun returns [] when labeling yields nothing", async () => {
  expect(await processRun({ request: "???", transcript: "", output: "" }, 1, { label: async () => [] })).toEqual([]);
});
