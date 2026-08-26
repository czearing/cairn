import { test, expect } from "bun:test";
import { matchEvent } from "../src/inject/matchers";

const tool = (t: string) =>
  matchEvent({ kind: "tool_completed", tool: t, input: {}, output: null });

test("user message → user-message.md on first turn, workflow-reminder.md on subsequent turns", () => {
  expect(matchEvent({ kind: "user_message", text: "hi" })).toEqual({ promptFile: "user-message.md" });
  expect(matchEvent({ kind: "user_message", text: "hi", turnSeq: 1 })).toEqual({ promptFile: "user-message.md" });
  expect(matchEvent({ kind: "user_message", text: "hi", turnSeq: 2 })).toEqual({ promptFile: "workflow-reminder.md" });
});

test("brain_search → search-results.md", () => {
  expect(tool("brain_search")).toEqual({ promptFile: "search-results.md" });
});

test("brain_create → node-created.md", () => {
  expect(tool("brain_create")).toEqual({ promptFile: "node-created.md" });
});

test("brain_mutate → no repeated reminder", () => {
  expect(tool("brain_mutate")).toBeNull();
});

test("namespaced MCP tool names match", () => {
  expect(tool("mcp__cairn__brain_create")).toEqual({ promptFile: "node-created.md" });
});

test("unrelated tool → no match", () => {
  expect(tool("Read")).toBeNull();
});
