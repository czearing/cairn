import { test, expect } from "bun:test";
import { condenseMessages, injectionText, skillInstructions, explainInjection, isBareUrlQuery } from "../src/skill/retrieve";
import { isSkillWorker, learnFromTranscript } from "../src/skill/learn";
import type { Skill } from "../src/skill/types";

test("condenseMessages turns many messages into ONE bounded query (no per-message search)", () => {
  expect(condenseMessages(["write me", "a haiku", "about frost"])).toBe("write me a haiku about frost");
  expect(condenseMessages(["a", "b", "c", "d", "e"])).toBe("c d e"); // keeps only the recent context
  expect(condenseMessages(["  ", "", "haiku"])).toBe("haiku");        // blanks dropped
  expect(condenseMessages([])).toBe("");
  expect(condenseMessages(["x".repeat(5000)]).length).toBe(2000);     // bounded
});

test("bare URL detection is strict and supports browser, localhost, and file targets", () => {
  expect(isBareUrlQuery("https://example.com/path?q=1")).toBe(true);
  expect(isBareUrlQuery("http://localhost:3000")).toBe(true);
  expect(isBareUrlQuery("localhost:4173/story")).toBe(true);
  expect(isBareUrlQuery("file:///C:/Code/prototype/index.html")).toBe(true);
  expect(isBareUrlQuery("recreate https://example.com")).toBe(false);
  expect(isBareUrlQuery("not a url")).toBe(false);
});

test("instructions and explanation are separate inputs; injecting instructions alone omits the framing", () => {
  const skill: Skill = { id: "s", task: "haiku", masterPrompt: "draft 5-7-5, then sharpen the turn", ts: 1 };
  expect(skillInstructions([skill])).toBe("draft 5-7-5, then sharpen the turn"); // the given skill, no framing
  const expl = explainInjection([skill]);
  expect(expl.toLowerCase()).toContain("curated");
  expect(expl).toContain("haiku");
  expect(expl).not.toContain("draft 5-7-5");                       // explanation carries no instructions

  const t = injectionText(skillInstructions([skill]), expl);       // composed: explanation above instructions
  expect(t).toBe(`${expl}\n\ndraft 5-7-5, then sharpen the turn`);

  expect(injectionText(skillInstructions([skill]))).toBe("draft 5-7-5, then sharpen the turn"); // only the skill
  expect(injectionText(skillInstructions([{ ...skill, masterPrompt: "" }]))).toBe("");
  expect(injectionText(skillInstructions([]))).toBe("");
});

test("a related cluster stacks instructions under task headers while the explanation names them", () => {
  const skills: Skill[] = [
    { id: "1", task: "poem", masterPrompt: "vivid imagery, a turn", ts: 1 },
    { id: "2", task: "haiku", masterPrompt: "5-7-5, a kigo", ts: 1 },
  ];
  const instr = skillInstructions(skills);
  expect(instr).toContain("## poem");
  expect(instr).toContain("vivid imagery");
  expect(instr).toContain("5-7-5, a kigo");

  const expl = explainInjection(skills);
  expect(expl).toContain("poem, haiku");   // names the related cluster
  expect(expl).not.toContain("vivid imagery");

  const t = injectionText(instr, expl);
  expect(t).toContain("poem, haiku");
  expect(t).toContain("vivid imagery");
  expect(t).toContain("5-7-5, a kigo");
});

test("loop guard: learnFromTranscript is a no-op inside a worker, and isSkillWorker reads the env", () => {
  const prev = process.env.CAIRN_SKILL_WORKER;
  process.env.CAIRN_SKILL_WORKER = "1";
  expect(isSkillWorker()).toBe(true);
  expect(learnFromTranscript("/some/transcript.jsonl", "haiku")).toBe(false); // a worker never spawns another learn
  if (prev === undefined) delete process.env.CAIRN_SKILL_WORKER; else process.env.CAIRN_SKILL_WORKER = prev;
  expect(isSkillWorker()).toBe(false);
});

test("learnFromTranscript is a no-op with no transcript path", () => {
  expect(learnFromTranscript("", "haiku")).toBe(false);
});
