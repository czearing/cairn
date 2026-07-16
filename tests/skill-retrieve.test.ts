import { test, expect } from "bun:test";
import { isSkillWorker, learnFromTranscript } from "../src/skill/learn";

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
