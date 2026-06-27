import { test, expect } from "bun:test";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { brainUsedThisTurn, mutatedIdsThisTurn } from "../src/hosts/claude-code/transcript";
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

const toolUseInput = (name: string, input: object) => ({
  message: { role: "assistant", content: [{ type: "tool_use", name, input }] },
});

test("mutatedIdsThisTurn collects ids from this turn's brain_mutate calls only", async () => {
  const p = transcript([
    userMsg("first"),
    toolUseInput("brain_mutate", { id: "old-id", answer: "a" }), // previous turn — excluded
    userMsg("second"),
    toolUseInput("mcp__cairn__brain_mutate", { id: "n1", answer: "x" }),
    toolUseInput("brain_mutate", { id: "n2", citation: "https://e.x" }),
    toolUse("brain_create"), // no id on input — ignored
  ]);
  const ids = await mutatedIdsThisTurn(p);
  expect([...ids].sort()).toEqual(["n1", "n2"]);
  expect(ids.has("old-id")).toBe(false);
});

test("mutatedIdsThisTurn fails open (empty set) on a missing transcript", async () => {
  expect((await mutatedIdsThisTurn("C:/nope/does-not-exist.jsonl")).size).toBe(0);
});

test("tail-read still scopes to the current turn on a multi-megabyte transcript", async () => {
  // >1 MiB of earlier history so the whole file cannot fit the tail window; the current turn is at the end.
  const filler = Array.from({ length: 4000 }, (_, i) => asstText(`old line ${i} ` + "x".repeat(300)));
  const p = transcript([userMsg("first"), toolUse("brain_search"), ...filler, userMsg("second"), toolUse("brain_mutate")]);
  expect(await brainUsedThisTurn(p)).toBe(true);                 // finds this turn's brain_mutate via the tail
  expect([...(await mutatedIdsThisTurn(transcript([userMsg("first"), ...filler, userMsg("second"), toolUseInput("brain_mutate", { id: "z9", answer: "a" })]))).values()]).toEqual(["z9"]);
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
