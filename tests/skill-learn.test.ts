import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { learnFromTranscript } from "../src/skill/learn";

const DIR = join(tmpdir(), `cairn-learners-${randomUUID()}`);
beforeEach(() => {
  process.env.CAIRN_LEARNERS_DIR = DIR;
  process.env.CAIRN_MAX_LEARNERS = "2";
  try { rmSync(DIR, { recursive: true, force: true }); } catch { /* none */ }
  mkdirSync(DIR, { recursive: true });
});
afterEach(() => {
  delete process.env.CAIRN_LEARNERS_DIR;
  delete process.env.CAIRN_MAX_LEARNERS;
  try { rmSync(DIR, { recursive: true, force: true }); } catch { /* none */ }
});

test("learnFromTranscript skips (returns false) when the concurrency cap is already reached", () => {
  writeFileSync(join(DIR, "a.lock"), "1");
  writeFileSync(join(DIR, "b.lock"), "1"); // 2 active learners, cap is 2
  expect(learnFromTranscript(join(tmpdir(), "nope.jsonl"))).toBe(false); // over cap -> no spawn
});

test("learnFromTranscript is a no-op inside a worker, and with no transcript path", () => {
  const prev = process.env.CAIRN_SKILL_WORKER;
  process.env.CAIRN_SKILL_WORKER = "1";
  expect(learnFromTranscript(join(tmpdir(), "x.jsonl"))).toBe(false); // worker loop guard
  if (prev === undefined) delete process.env.CAIRN_SKILL_WORKER; else process.env.CAIRN_SKILL_WORKER = prev;
  expect(learnFromTranscript("")).toBe(false);                         // nothing to learn
});
