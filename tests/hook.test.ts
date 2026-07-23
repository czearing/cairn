import { test, expect } from "bun:test";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { brainUsedThisTurn } from "../src/hosts/claude-code/transcript";
import { matchEvent } from "../src/inject/matchers";
import { normalizeClaudeCode } from "../src/hosts/claude-code/normalize";
import { respond, modifyPreTool } from "../src/hosts/claude-code/respond";

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

test("tail-read still scopes to the current turn on a multi-megabyte transcript", async () => {
  // >1 MiB of earlier history so the whole file cannot fit the tail window; the current turn is at the end.
  const filler = Array.from({ length: 4000 }, (_, i) => asstText(`old line ${i} ` + "x".repeat(300)));
  const p = transcript([userMsg("first"), toolUse("brain_search"), ...filler, userMsg("second"), toolUse("brain_mutate")]);
  expect(await brainUsedThisTurn(p)).toBe(true);                 // finds this turn's brain_mutate via the tail
});

test("turn_finished routing: unused brain nags, otherwise done", () => {
  expect(matchEvent({ kind: "turn_finished", usedBrain: false })).toEqual({ promptFile: "turn-reminder.md" });
  expect(matchEvent({ kind: "turn_finished", usedBrain: true })).toBeNull();
});

// ── post-tool injection + timing ─────────────────────────────────────────────────

test("brain writes do not repeat invariant formatting before the tool", () => {
  expect(matchEvent({ kind: "tool_pending", tool: "brain_create", input: {} })).toBeNull();
  expect(matchEvent({ kind: "tool_pending", tool: "mcp__cairn__brain_mutate", input: {} })).toBeNull();
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

test("brain_mutate does not repeat the base atomicity contract", () => {
  const completed = (tool: string, input: Record<string, unknown>) => matchEvent({ kind: "tool_completed", tool, input, output: null });
  expect(completed("brain_mutate", { answer: "x" })).toBeNull();
  expect(completed("mcp__cairn__brain_mutate", { id: "1", answer: "y" })).toBeNull();
  expect(completed("brain_mutate", { edges: [] })).toBeNull();
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

test("modifyPreTool rewrites the tool input (and optionally adds parent context)", () => {
  // Rewriting a subagent's prompt: updatedInput REPLACES the tool input before it runs.
  expect(modifyPreTool({ prompt: "PROTO\n\norig" })).toEqual({
    hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", updatedInput: { prompt: "PROTO\n\norig" } },
  });
  // With parent-facing context too.
  expect(modifyPreTool({ prompt: "x" }, "PARENT")).toEqual({
    hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", updatedInput: { prompt: "x" }, additionalContext: "PARENT" },
  });
});
