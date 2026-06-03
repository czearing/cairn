import { test, expect, beforeAll, beforeEach } from "bun:test";

let A: typeof import("../src/core/audit");
let N: typeof import("../src/core/neurons");
let DB: typeof import("../src/core/db");

beforeAll(async () => {
  A = await import("../src/core/audit");
  N = await import("../src/core/neurons");
  DB = await import("../src/core/db");
});
beforeEach(() => DB.db().run("DELETE FROM neurons"));

test("isListish flags lists and multi-sentence syntheses, not single facts", () => {
  expect(A.isListish("")).toBe(false);
  expect(A.isListish("Paris is the capital of France.")).toBe(false);
  expect(A.isListish("intro:\n- one\n- two")).toBe(true); // newline list
  expect(A.isListish("One. Two. Three. Four.")).toBe(true); // > 2 sentences
  expect(A.isListish("x".repeat(400))).toBe(true); // long synthesis
});

test("unsplitLeaves flags an answered single-edge node with a list answer", async () => {
  const root = await N.create("root");
  const leaf = await N.create("leaf", [root.id]);
  await N.mutate(leaf.id, { answer: "intro:\n- a\n- b", citation: "https://x" });
  const ids = A.unsplitLeaves().map((n) => n.id);
  expect(ids).toContain(leaf.id);
  expect(ids).not.toContain(root.id); // root's answer is empty
});

test("rootId is the earliest node; openBranchExists tracks open non-root nodes", async () => {
  const root = await N.create("root");
  expect(A.rootId()).toBe(root.id);
  expect(A.openBranchExists()).toBe(false);
  const child = await N.create("child", [root.id]);
  expect(A.openBranchExists()).toBe(true);
  await N.mutate(child.id, { answer: "Paris.", citation: "https://x" });
  expect(A.openBranchExists()).toBe(false);
});
