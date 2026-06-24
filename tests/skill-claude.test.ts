import { test, expect } from "bun:test";
import { buildArgs } from "../src/skill/claude";

const after = (a: string[], flag: string) => a[a.indexOf(flag) + 1];

test("buildArgs runs headless, hook-free, clean output", () => {
  const a = buildArgs();
  expect(a[0]).toBe("-p");                        // prompt comes on stdin, not argv
  expect(after(a, "--setting-sources")).toBe("project"); // drops user-level cairn hooks
  expect(after(a, "--output-format")).toBe("text");
});

test("buildArgs wires the system prompt, cairn mcp, and tool allowlist", () => {
  const a = buildArgs({ system: "SYS", mcpConfigPath: "/tmp/c.json", allowedTools: ["mcp__cairn__brain_search"] });
  expect(after(a, "--append-system-prompt")).toBe("SYS");
  expect(after(a, "--mcp-config")).toBe("/tmp/c.json");
  expect(after(a, "--allowedTools")).toBe("mcp__cairn__brain_search");
});

test("buildArgs allows no tools by default", () => {
  expect(after(buildArgs(), "--allowedTools")).toBe("");
});

test("buildArgs omits optional flags when not set", () => {
  const a = buildArgs();
  expect(a).not.toContain("--append-system-prompt");
  expect(a).not.toContain("--mcp-config");
});
