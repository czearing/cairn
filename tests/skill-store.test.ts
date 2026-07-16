import { test, expect, beforeEach } from "bun:test";
import { putSkill, getSkill, setMasterPrompt, setSkillMetadata, skillVectors, addRun, topRuns, insertSkillIfAbsent, skillByLabel, listSkills, variantSkills, setBaseLabel, setIdentityVector, skillIdentityVector, deleteSkillByLabel, deleteSkill, skillCatalog, addVersion, skillVersions } from "../src/skill/store";
import { db } from "../src/core/db";
import { formatSkillCatalog, skillCatalogSnapshot } from "../src/skill/catalog";

beforeEach(() => {
  try { db().run("DELETE FROM skills"); } catch { /* not created yet */ }
  try { db().run("DELETE FROM skill_runs"); } catch { /* not created yet */ }
});

test("variantSkills matches minted variants by base_label, never an unrelated user label starting with the base", () => {
  putSkill({ id: "base", task: "pr monitor", masterPrompt: "m", ts: 1 }, [1, 0]);
  putSkill({ id: "user", task: "pr monitor 2024 audit", masterPrompt: "m", ts: 2 }, [0, 1]); // a real, unrelated user skill
  expect(variantSkills("pr monitor").map((v) => v.task).sort()).toEqual(["pr monitor"]); // the user skill is NOT a variant
  putSkill({ id: "v", task: "pr monitor (2)", masterPrompt: "m", ts: 3 }, [0, 0, 1]);
  setBaseLabel("v", "pr monitor");                                  // a genuinely minted variant
  expect(variantSkills("pr monitor").map((v) => v.task).sort()).toEqual(["pr monitor", "pr monitor (2)"]);
});

test("setIdentityVector freezes the vector once and never overwrites it", () => {
  putSkill({ id: "s", task: "t", masterPrompt: "", ts: 1 }, [1, 0]);
  setIdentityVector("s", [0.1, 0.2, 0.3], "first");
  const v1 = skillIdentityVector("s");
  expect(v1.length).toBe(3);
  setIdentityVector("s", [0.9, 0.8, 0.7], "second");                // attempt to clobber a frozen identity
  expect(skillIdentityVector("s")).toEqual(v1);                     // unchanged: it stays frozen
  expect(skillIdentityVector("s")[0]).not.toBeCloseTo(0.9, 5);      // definitely not the second vector
});

test("deleteSkillByLabel removes the skill and its runs, by normalized label; returns false when absent", () => {
  putSkill({ id: "k", task: "pr monitor 2", masterPrompt: "stub", ts: 1 }, [1, 0]);
  addRun({ skillId: "k", recipe: "r", quality: 0.5, review: "", ts: 1 });
  expect(deleteSkillByLabel("PR Monitor 2")).toBe(true);   // normalized to the same key
  expect(skillByLabel("pr monitor 2")).toBeNull();          // skill gone
  expect(topRuns("k", 10).length).toBe(0);                  // its runs gone too
  expect(deleteSkillByLabel("never existed")).toBe(false);  // absent -> false, no throw
});

test("deleteSkill removes the skill and its runs AND its version history, by id", () => {
  putSkill({ id: "d", task: "doomed", masterPrompt: "m", ts: 1 }, [1, 0]);
  addRun({ skillId: "d", recipe: "r", quality: 0.6, review: "", ts: 1 });
  addVersion("d", "m", "why", 0.6, 1);
  expect(deleteSkill("d")).toBe(true);
  expect(getSkill("d")).toBeNull();
  expect(topRuns("d", 10).length).toBe(0);
  expect(skillVersions("d").length).toBe(0);
  expect(deleteSkill("nope")).toBe(false); // absent -> false, no throw
});

test("addVersion records each CHANGED master (dedup unchanged), skillVersions returns them oldest-first", () => {
  putSkill({ id: "v1", task: "t", masterPrompt: "", ts: 1 }, [1, 0]);
  addVersion("v1", "master A", "why A", 0.7, 100);
  addVersion("v1", "master A", "why A v2", 0.7, 110);  // identical master -> NOT a new version
  addVersion("v1", "master B", "why B", 0.85, 120);
  const vs = skillVersions("v1");
  expect(vs.map((v) => v.master)).toEqual(["master A", "master B"]); // oldest first, the dup dropped
  expect(vs[1]!.explanation).toBe("why B");
  expect(vs[1]!.score).toBeCloseTo(0.85, 5);
});

test("listSkills includes the master-version timeline", () => {
  putSkill({ id: "v2", task: "t2", masterPrompt: "B", ts: 1 }, [1, 0]);
  setSkillMetadata("v2", "timeline skill", "Use for testing complete skill master version timelines and history rendering.");
  putSkill({ id: "pending", task: "pending", masterPrompt: "", ts: 2 }, [0, 1]);
  addVersion("v2", "A", "wA", 0.6, 1);
  addVersion("v2", "B", "wB", 0.8, 2);
  const listed = listSkills();
  const sk = listed.find((x) => x.id === "v2")!;
  expect(sk.versions.length).toBe(2);
  expect(sk.versions[0]!.master).toBe("A"); // oldest first
  expect(listed.some((x) => x.id === "pending")).toBe(false);
});

test("skillCatalog lists learned skills and hides pending skills without a master", () => {
  putSkill({ id: "c1", task: "haiku", masterPrompt: "1. count 5-7-5 syllables\n2. sharpen the cut", ts: 1 }, [1, 0]);
  setSkillMetadata("c1", "poetry writing", "Use for writing haiku and short poems or revising poetry through deliberate imagery, form, sound, and compression.");
  putSkill({ id: "c2", task: "blank", masterPrompt: "", ts: 2 }, [0, 1]);
  const cat = skillCatalog();
  expect(cat).toContainEqual({
    id: "c1",
    title: "poetry writing",
    description: "Use for writing haiku and short poems or revising poetry through deliberate imagery, form, sound, and compression.",
  });
  expect(cat.some((s) => s.id === "c2")).toBe(false);
  expect(formatSkillCatalog()).toContain("`c1` **poetry writing**");
  expect(formatSkillCatalog()).toContain("Use for writing haiku");
  const first = skillCatalogSnapshot();
  expect(formatSkillCatalog()).toContain(`Catalog version: \`${first.version}\``);
  setMasterPrompt("c1", "1. draft the image\n2. sharpen the cut");
  expect(skillCatalogSnapshot().version).not.toBe(first.version);
});

test("putSkill/getSkill round-trips, vector decodes back", () => {
  putSkill({ id: "s1", task: "write a haiku", masterPrompt: "draft then check 5-7-5", ts: 1 }, [0.1, 0.2, 0.3]);
  setSkillMetadata("s1", "write a haiku", "Use for writing haiku with deliberate imagery, form, sound, compression, and a clear turn.");
  expect(getSkill("s1")).toEqual({
    id: "s1",
    task: "write a haiku",
    masterPrompt: "draft then check 5-7-5",
    description: "Use for writing haiku with deliberate imagery, form, sound, compression, and a clear turn.",
    explanation: "",
    ts: 1,
  });
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

test("addRun preserves complete history while topRuns returns the requested best subset", () => {
  putSkill({ id: "s1", task: "t", masterPrompt: "", ts: 1 }, [1, 0]);
  for (let i = 0; i < 14; i++) addRun({ skillId: "s1", recipe: `r${i}`, quality: i / 14, review: "", ts: 100 + i });
  const top = topRuns("s1", 10);
  expect(top.length).toBe(10);
  expect(top[0]!.quality).toBeCloseTo(13 / 14, 5);              // best first
  expect(top.every((r) => r.quality >= 4 / 14)).toBe(true);    // the four worst were dropped
  expect((db().query("SELECT COUNT(*) count FROM skill_runs WHERE skill_id = 's1'").get() as { count: number }).count).toBe(14);
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
  expect(skillCatalog().length).toBe(0);       // pending skill stays hidden until its first master
});

test("skillByLabel resolves the exact restore key, null when absent", () => {
  putSkill({ id: "s1", task: "write a sonnet", masterPrompt: "", ts: 1 }, [1, 0]);
  expect(skillByLabel("sonnet")!.id).toBe("s1");
  expect(skillByLabel("haiku")).toBeNull();
});

test("listSkills returns each skill with its runs in chronological order (for the viewer)", () => {
  putSkill({ id: "s1", task: "haiku", masterPrompt: "m", ts: 5 }, [1, 0]);
  setSkillMetadata("s1", "haiku", "Use for writing haiku with deliberate imagery, form, sound, compression, and a clear turn.");
  addRun({ skillId: "s1", recipe: "r1", quality: 0.8, review: "", ts: 1 });
  addRun({ skillId: "s1", recipe: "r2", quality: 0.9, review: "", ts: 2 });
  const list = listSkills();
  expect(list.length).toBe(1);
  expect(list[0]!.task).toBe("haiku");
  expect(list[0]!.runs.map((r) => r.quality)).toEqual([0.8, 0.9]); // time order, not quality order
});
