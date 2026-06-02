import { test, expect } from "bun:test";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { brainUsedThisTurn } from "../src/hosts/claude-code/transcript";
import { matchEvent } from "../src/inject/matchers";

function transcript(entries: object[]): string {
  const p = join(tmpdir(), `cairn-tx-${randomUUID()}.jsonl`);
  writeFileSync(p, entries.map((e) => JSON.stringify(e)).join("\n"));
  return p;
}
const userMsg = (text: string) => ({ type: "user", message: { role: "user", content: text } });
const toolUse = (name: string) => ({ message: { role: "assistant", content: [{ type: "tool_use", name }] } });
const asstText = (t: string) => ({ message: { role: "assistant", content: [{ type: "text", text: t }] } });
const toolResult = () => ({ type: "user", message: { role: "user", content: [{ type: "tool_result", content: "x" }] } });

test("detects a namespaced brain_search used this turn", async () => {
  const p = transcript([userMsg("hi"), toolUse("Read"), toolUse("mcp__cairn__brain_search"), toolResult(), asstText("done")]);
  expect(await brainUsedThisTurn(p)).toBe(true);
});

test("detects brain_mutate used this turn", async () => {
  expect(await brainUsedThisTurn(transcript([userMsg("hi"), toolUse("brain_mutate")]))).toBe(true);
});

test("false when no brain tool was used this turn", async () => {
  const p = transcript([userMsg("hi"), toolUse("Read"), toolUse("Edit"), asstText("done")]);
  expect(await brainUsedThisTurn(p)).toBe(false);
});

test("ignores brain use from a PREVIOUS turn", async () => {
  const p = transcript([userMsg("first"), toolUse("brain_search"), userMsg("second"), toolUse("Read")]);
  expect(await brainUsedThisTurn(p)).toBe(false);
});

test("missing transcript fails safe (no nag)", async () => {
  expect(await brainUsedThisTurn("C:/nope/does-not-exist.jsonl")).toBe(true);
});

test("matcher nudges only when the brain went unused", () => {
  expect(matchEvent({ kind: "turn_finished", usedBrain: false })).toEqual({ promptFile: "turn-reminder.md" });
  expect(matchEvent({ kind: "turn_finished", usedBrain: true })).toBeNull();
});
