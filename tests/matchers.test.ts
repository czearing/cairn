import { test, expect } from "bun:test";
import { matchEvent } from "../src/inject/matchers";

const tool = (t: string) =>
  matchEvent({ kind: "tool_completed", tool: t, input: {}, output: null });

test("user message → user-message.md", () => {
  expect(matchEvent({ kind: "user_message", text: "hi" })).toEqual({ promptFile: "user-message.md" });
});

test("brain_search → search-results.md", () => {
  expect(tool("brain_search")).toEqual({ promptFile: "search-results.md" });
});

test("brain_create → node-created.md", () => {
  expect(tool("brain_create")).toEqual({ promptFile: "node-created.md" });
});

test("brain_mutate → node-modified.md", () => {
  expect(tool("brain_mutate")).toEqual({ promptFile: "node-modified.md" });
});

test("namespaced MCP tool names match", () => {
  expect(tool("mcp__cairn__brain_create")).toEqual({ promptFile: "node-created.md" });
});

test("Task → subtask-spawned.md", () => {
  expect(tool("Task")).toEqual({ promptFile: "subtask-spawned.md" });
});

test("unrelated tool → no match", () => {
  expect(tool("Read")).toBeNull();
});
