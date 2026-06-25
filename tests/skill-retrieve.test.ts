import { test, expect } from "bun:test";
import { condenseMessages, injectionText } from "../src/skill/retrieve";
import { isSkillWorker, learnInBackground } from "../src/skill/learn";
import type { Skill } from "../src/skill/types";

test("condenseMessages turns many messages into ONE bounded query (no per-message search)", () => {
  expect(condenseMessages(["write me", "a haiku", "about frost"])).toBe("write me a haiku about frost");
  expect(condenseMessages(["a", "b", "c", "d", "e"])).toBe("c d e"); // keeps only the recent context
  expect(condenseMessages(["  ", "", "haiku"])).toBe("haiku");        // blanks dropped
  expect(condenseMessages([])).toBe("");
  expect(condenseMessages(["x".repeat(5000)]).length).toBe(2000);     // bounded
});

test("injectionText frames the master prompt as curated steps; empty master yields nothing", () => {
  const skill: Skill = { id: "s", task: "haiku", masterPrompt: "draft 5-7-5, then sharpen the turn", ts: 1 };
  const t = injectionText(skill);
  expect(t).toContain("haiku");
  expect(t).toContain("draft 5-7-5, then sharpen the turn");
  expect(t.toLowerCase()).toContain("curated");
  expect(injectionText({ ...skill, masterPrompt: "" })).toBe("");
});

test("loop guard: learnInBackground is a no-op inside a worker, and isSkillWorker reads the env", () => {
  const prev = process.env.CAIRN_SKILL_WORKER;
  process.env.CAIRN_SKILL_WORKER = "1";
  expect(isSkillWorker()).toBe(true);
  expect(learnInBackground({ request: "x", transcript: "y", output: "z" }, 1)).toBe(false); // no recursion
  if (prev === undefined) delete process.env.CAIRN_SKILL_WORKER; else process.env.CAIRN_SKILL_WORKER = prev;
  expect(isSkillWorker()).toBe(false);
});
