import { test, expect } from "bun:test";
import { buildArgs, runClaude } from "../src/skill/claude";

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

test("buildArgs pins the model when given, and omits --model otherwise", () => {
  expect(after(buildArgs({ model: "claude-sonnet-4-6" }), "--model")).toBe("claude-sonnet-4-6");
  expect(buildArgs()).not.toContain("--model");
});

test("buildArgs omits optional flags when not set", () => {
  const a = buildArgs();
  expect(a).not.toContain("--append-system-prompt");
  expect(a).not.toContain("--mcp-config");
});

test("runClaude surfaces the real failure reason instead of failing silently", async () => {
  const prev = process.env.CAIRN_CLAUDE_BIN;
  process.env.CAIRN_CLAUDE_BIN = "cairn-no-such-binary-xyz"; // a command that cannot spawn
  try {
    const r = await runClaude("hello");
    expect(r.ok).toBe(false);
    expect(r.error).toBeTruthy();          // the reason is reported, not swallowed
    expect(r.error).not.toMatch(/transient/i); // and it is the real error, never a guessed "transient"
  } finally {
    if (prev === undefined) delete process.env.CAIRN_CLAUDE_BIN; else process.env.CAIRN_CLAUDE_BIN = prev;
  }
});
