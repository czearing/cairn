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

test("rootId is the earliest node; openBranchExists tracks open non-root nodes", async () => {
  const root = await N.create("root");
  expect(A.rootId()).toBe(root.id);
  expect(A.openBranchExists()).toBe(false);
  const child = await N.create("child", [root.id]);
  expect(A.openBranchExists()).toBe(true);
  await N.mutate(child.id, { answer: "Paris.", citation: "https://x" });
  expect(A.openBranchExists()).toBe(false);
});
