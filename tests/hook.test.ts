import { test, expect } from "bun:test";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { brainUsedThisTurn } from "../src/hosts/claude-code/transcript";
import { matchEvent } from "../src/inject/matchers";
import { normalizeClaudeCode } from "../src/hosts/claude-code/normalize";
import { respond } from "../src/hosts/claude-code/respond";

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

test("turn_finished routing: unused brain, unsplit leaves, or done", () => {
  expect(matchEvent({ kind: "turn_finished", usedBrain: false, unsplit: 0 })).toEqual({ promptFile: "turn-reminder.md" });
  expect(matchEvent({ kind: "turn_finished", usedBrain: true, unsplit: 3 })).toEqual({ promptFile: "split-leaves.md" });
  expect(matchEvent({ kind: "turn_finished", usedBrain: true, unsplit: 0 })).toBeNull();
});

// ── entry-format injection + timing ──────────────────────────────────────────────

test("format prompt fires only before a WRITE (brain_create/brain_mutate)", () => {
  const fmt = { promptFile: "entry-format.md" };
  expect(matchEvent({ kind: "tool_pending", tool: "brain_create", input: {} })).toEqual(fmt);
  expect(matchEvent({ kind: "tool_pending", tool: "mcp__cairn__brain_mutate", input: {} })).toEqual(fmt);
  // not before a read or an unrelated tool
  expect(matchEvent({ kind: "tool_pending", tool: "brain_search", input: {} })).toBeNull();
  expect(matchEvent({ kind: "tool_pending", tool: "Read", input: {} })).toBeNull();
});

test("TIMING: a write maps to PreToolUse (before) and PostToolUse (after) distinctly", async () => {
  const payload = { tool_name: "brain_create", tool_input: { text: "x" } };
  const pre = await normalizeClaudeCode({ ...payload, hook_event_name: "PreToolUse" });
  expect(pre).toEqual({ kind: "tool_pending", tool: "brain_create", input: { text: "x" } });
  const post = await normalizeClaudeCode({ ...payload, hook_event_name: "PostToolUse", tool_output: {} });
  expect(post?.kind).toBe("tool_completed");
});

test("answering a node (brain_mutate with answer) triggers the split-check", () => {
  const completed = (tool: string, input: Record<string, unknown>) => matchEvent({ kind: "tool_completed", tool, input, output: null });
  expect(completed("brain_mutate", { answer: "x" })).toEqual({ promptFile: "answer-check.md" });
  expect(completed("mcp__cairn__brain_mutate", { id: "1", answer: "y" })).toEqual({ promptFile: "answer-check.md" });
  // edits that don't set an answer are just modifications
  expect(completed("brain_mutate", { edges: [] })).toEqual({ promptFile: "node-modified.md" });
});

test("delivery mechanism per moment is correct", () => {
  // PreToolUse injects context and ALLOWS — never rejects.
  expect(respond("PreToolUse", "FMT")).toEqual({
    hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", additionalContext: "FMT" },
  });
  expect(respond("Stop", "R")).toEqual({ decision: "block", reason: "R" });
  expect(respond("PostToolUse", "C")).toEqual({
    hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: "C" },
  });
});
