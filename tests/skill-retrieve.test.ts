import { test, expect } from "bun:test";
import { condenseMessages, injectionText } from "../src/skill/retrieve";
import { isSkillWorker, learnFromTranscript } from "../src/skill/learn";
import type { Skill } from "../src/skill/types";

test("condenseMessages turns many messages into ONE bounded query (no per-message search)", () => {
  expect(condenseMessages(["write me", "a haiku", "about frost"])).toBe("write me a haiku about frost");
  expect(condenseMessages(["a", "b", "c", "d", "e"])).toBe("c d e"); // keeps only the recent context
  expect(condenseMessages(["  ", "", "haiku"])).toBe("haiku");        // blanks dropped
  expect(condenseMessages([])).toBe("");
  expect(condenseMessages(["x".repeat(5000)]).length).toBe(2000);     // bounded
});

test("injectionText frames one skill's master prompt as curated steps; empty yields nothing", () => {
  const skill: Skill = { id: "s", task: "haiku", masterPrompt: "draft 5-7-5, then sharpen the turn", ts: 1 };
  const t = injectionText([skill]);
  expect(t).toContain("haiku");
  expect(t).toContain("draft 5-7-5, then sharpen the turn");
  expect(t.toLowerCase()).toContain("curated");
  expect(injectionText([{ ...skill, masterPrompt: "" }])).toBe("");
  expect(injectionText([])).toBe("");
});

test("injectionText draws from a related cluster when several skills match", () => {
  const t = injectionText([
    { id: "1", task: "poem", masterPrompt: "vivid imagery, a turn", ts: 1 },
    { id: "2", task: "haiku", masterPrompt: "5-7-5, a kigo", ts: 1 },
  ]);
  expect(t).toContain("poem, haiku");      // names the related cluster
  expect(t).toContain("vivid imagery");
  expect(t).toContain("5-7-5, a kigo");
});

test("loop guard: learnFromTranscript is a no-op inside a worker, and isSkillWorker reads the env", () => {
  const prev = process.env.CAIRN_SKILL_WORKER;
  process.env.CAIRN_SKILL_WORKER = "1";
  expect(isSkillWorker()).toBe(true);
  expect(learnFromTranscript("/some/transcript.jsonl")).toBe(false); // a worker never spawns another learn
  if (prev === undefined) delete process.env.CAIRN_SKILL_WORKER; else process.env.CAIRN_SKILL_WORKER = prev;
  expect(isSkillWorker()).toBe(false);
});

test("learnFromTranscript is a no-op with no transcript path", () => {
  expect(learnFromTranscript("")).toBe(false);
});
