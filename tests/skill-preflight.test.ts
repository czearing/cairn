import { test, expect } from "bun:test";
import { skillPreflight } from "../src/skill/preflight";

test("skillPreflight returns the three dependency checks, each with a fix command", () => {
  const checks = skillPreflight();
  expect(checks.map((c) => c.name)).toEqual(["claude CLI", "bun", "cairn MCP server"]);
  for (const c of checks) {
    expect(typeof c.ok).toBe("boolean");
    expect(c.fix.length).toBeGreaterThan(0); // every failure path names its fix
    if (!c.ok) console.error(`preflight: ${c.name} -> ${c.fix}`);
  }
});

test("skillPreflight resolves the cairn MCP server and bun (the test runner)", () => {
  const checks = skillPreflight();
  expect(checks.find((c) => c.name === "cairn MCP server")!.ok).toBe(true); // server file resolves in-repo
  expect(checks.find((c) => c.name === "bun")!.ok).toBe(true);              // bun is running these tests
});
