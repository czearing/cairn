import { test, expect } from "bun:test";
import { writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { extractRun } from "../src/skill/transcript";
import { skillsEnabled, skillInject, skillLearn } from "../src/skill/hook";

test("extractRun pulls request (first user) and output (last assistant) from a transcript", () => {
  const p = join(tmpdir(), `cairn-tx-${process.pid}.jsonl`);
  writeFileSync(p, [
    JSON.stringify({ type: "user", message: { content: "write me a haiku about frost" } }),
    JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "first frost on the gate" }] } }),
    JSON.stringify({ type: "user", message: { content: "make it sharper" } }),
    JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "the whole field holds still" }] } }),
  ].join("\n"));
  const run = extractRun(p);
  rmSync(p, { force: true });
  expect(run!.request).toBe("write me a haiku about frost");
  expect(run!.output).toBe("the whole field holds still");
  expect(run!.transcript).toContain("[user] write me a haiku about frost");
});

test("extractRun returns null on an unreadable path", () => {
  expect(extractRun(join(tmpdir(), "does-not-exist-cairn.jsonl"))).toBeNull();
});

test("the skill layer is OFF unless CAIRN_SKILLS=1", async () => {
  const prev = process.env.CAIRN_SKILLS;
  delete process.env.CAIRN_SKILLS;
  expect(skillsEnabled()).toBe(false);
  expect(await skillInject("write me a haiku")).toBe("");   // disabled -> no injection
  expect(() => skillLearn("/some/path.jsonl")).not.toThrow(); // disabled -> no-op, never throws
  if (prev !== undefined) process.env.CAIRN_SKILLS = prev;
});
