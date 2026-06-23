import { test, expect } from "bun:test";
import { outcomeFromObjs } from "../src/hosts/claude-code/outcome";

// Build a transcript turn: a string-content user message starts the turn, then assistant tool_use and
// user tool_result lines, the shape Claude Code writes.
const assistant = (parts: unknown[]) => ({ type: "assistant", message: { content: parts } });
const userResult = (parts: unknown[]) => ({ type: "user", message: { content: parts } });
const search = (id: string, results: object[]) => [
  assistant([{ type: "tool_use", id, name: "brain_search", input: {} }]),
  userResult([{ type: "tool_result", tool_use_id: id, content: [{ type: "text", text: JSON.stringify(results) }] }]),
];
const bash = (id: string, out: string) => [
  assistant([{ type: "tool_use", id, name: "Bash", input: {} }]),
  userResult([{ type: "tool_result", tool_use_id: id, content: out }]),
];
const start = { type: "user", message: { content: "do the task" } };

test("outcome: brain_search top id is the used case; a passing test is success; steps counted", () => {
  const o = outcomeFromObjs([start, ...search("t1", [{ id: "CASE1" }, { id: "CASE2" }]), ...bash("t2", "130 pass\n 0 fail")]);
  expect(o).toEqual({ usedCaseId: "CASE1", success: true, steps: 2 });
});

test("outcome: a failing run is success=false", () => {
  const o = outcomeFromObjs([start, ...search("t1", [{ id: "CASE1" }]), ...bash("t2", "Exit code 1\n 3 fail")]);
  expect(o.success).toBe(false);
  expect(o.usedCaseId).toBe("CASE1");
});

test("outcome: no verification => success=null (never reinforce on a guess)", () => {
  const o = outcomeFromObjs([start, ...search("t1", [{ id: "CASE1" }]), ...bash("t2", "wrote a file")]);
  expect(o.success).toBeNull();
});

test("outcome: no brain_search => no used case", () => {
  const o = outcomeFromObjs([start, ...bash("t2", "0 fail")]);
  expect(o.usedCaseId).toBeNull();
  expect(o.success).toBe(true);
});

test("outcome: only the current turn counts, prior turns ignored", () => {
  const prior = [{ type: "user", message: { content: "old task" } }, ...search("p1", [{ id: "OLD" }])];
  const o = outcomeFromObjs([...prior, start, ...search("t1", [{ id: "NEW" }]), ...bash("t2", "tests pass")]);
  expect(o.usedCaseId).toBe("NEW"); // not OLD
  expect(o.steps).toBe(2);          // only this turn's tool calls
});
