import { test, expect, beforeEach } from "bun:test";
import { putSkill, getSkill, setMasterPrompt, skillVectors, addRun, topRuns, insertSkillIfAbsent, skillByLabel, listSkills } from "../src/skill/store";
import { db } from "../src/core/db";

beforeEach(() => {
  try { db().run("DELETE FROM skills"); } catch { /* not created yet */ }
  try { db().run("DELETE FROM skill_runs"); } catch { /* not created yet */ }
});

test("putSkill/getSkill round-trips, vector decodes back", () => {
  putSkill({ id: "s1", task: "write a haiku", masterPrompt: "draft then check 5-7-5", ts: 1 }, [0.1, 0.2, 0.3]);
  expect(getSkill("s1")).toEqual({ id: "s1", task: "write a haiku", masterPrompt: "draft then check 5-7-5", explanation: "", ts: 1 });
  const v = skillVectors().find((s) => s.id === "s1")!;
  expect(v.vec[0]).toBeCloseTo(0.1, 5);
  expect(v.vec.length).toBe(3);
});

test("setMasterPrompt replaces the instructions; explanation is set only when passed", () => {
  putSkill({ id: "s1", task: "t", masterPrompt: "old", explanation: "old why", ts: 1 }, [1, 0]);
  setMasterPrompt("s1", "new master prompt");                  // no explanation arg: leave it untouched
  expect(getSkill("s1")!.masterPrompt).toBe("new master prompt");
  expect(getSkill("s1")!.explanation).toBe("old why");
  expect(getSkill("s1")!.task).toBe("t");
  setMasterPrompt("s1", "newer steps", "new why");             // explanation passed: replace both
  expect(getSkill("s1")!.masterPrompt).toBe("newer steps");
  expect(getSkill("s1")!.explanation).toBe("new why");
});

test("addRun keeps only the top N runs by quality", () => {
  putSkill({ id: "s1", task: "t", masterPrompt: "", ts: 1 }, [1, 0]);
  for (let i = 0; i < 14; i++) addRun({ skillId: "s1", recipe: `r${i}`, quality: i / 14, review: "", ts: 100 + i }, 10);
  const top = topRuns("s1", 20);
  expect(top.length).toBe(10);                                  // pruned to 10
  expect(top[0]!.quality).toBeCloseTo(13 / 14, 5);              // best first
  expect(top.every((r) => r.quality >= 4 / 14)).toBe(true);    // the four worst were dropped
});

test("topRuns is scoped per skill", () => {
  putSkill({ id: "s1", task: "a", masterPrompt: "", ts: 1 }, [1, 0]);
  putSkill({ id: "s2", task: "b", masterPrompt: "", ts: 1 }, [0, 1]);
  addRun({ skillId: "s1", recipe: "ra", quality: 0.9, review: "", ts: 1 });
  addRun({ skillId: "s2", recipe: "rb", quality: 0.8, review: "", ts: 1 });
  expect(topRuns("s1").map((r) => r.recipe)).toEqual(["ra"]);
  expect(topRuns("s2").map((r) => r.recipe)).toEqual(["rb"]);
});

test("addRun stores the reviewer's review with the run", () => {
  putSkill({ id: "s1", task: "t", masterPrompt: "", ts: 1 }, [1, 0]);
  addRun({ skillId: "s1", recipe: "r", quality: 0.7, review: "imagery flat on line 2", ts: 1 });
  expect(topRuns("s1")[0]!.review).toBe("imagery flat on line 2");
});

test("insertSkillIfAbsent is idempotent on the normalized label (no duplicate skills under a race)", () => {
  insertSkillIfAbsent({ id: "A", task: "haiku", masterPrompt: "", ts: 1 }, [1, 0]);
  insertSkillIfAbsent({ id: "B", task: "Write a Haiku", masterPrompt: "", ts: 2 }, [0, 1]); // same normalized label
  expect(skillByLabel("haiku")!.id).toBe("A"); // first writer wins
  expect(skillVectors().length).toBe(1);       // exactly one skill, no duplicate
});

test("skillByLabel resolves the exact restore key, null when absent", () => {
  putSkill({ id: "s1", task: "write a sonnet", masterPrompt: "", ts: 1 }, [1, 0]);
  expect(skillByLabel("sonnet")!.id).toBe("s1");
  expect(skillByLabel("haiku")).toBeNull();
});

test("listSkills returns each skill with its runs in chronological order (for the viewer)", () => {
  putSkill({ id: "s1", task: "haiku", masterPrompt: "m", ts: 5 }, [1, 0]);
  addRun({ skillId: "s1", recipe: "r1", quality: 0.8, review: "", ts: 1 });
  addRun({ skillId: "s1", recipe: "r2", quality: 0.9, review: "", ts: 2 });
  const list = listSkills();
  expect(list.length).toBe(1);
  expect(list[0]!.task).toBe("haiku");
  expect(list[0]!.runs.map((r) => r.quality)).toEqual([0.8, 0.9]); // time order, not quality order
});
