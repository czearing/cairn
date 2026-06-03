// End-to-end: spawn the REAL hook with a payload on stdin, exactly as Claude Code invokes it.
// Proves the entry-format prompt is injected when a write tool is called — with NO rejection
// and NO length limit.
import { test, expect } from "bun:test";

async function fire(payload: object): Promise<string> {
  const proc = Bun.spawn(["bun", "src/hosts/claude-code/dispatch.ts"], {
    stdin: new TextEncoder().encode(JSON.stringify(payload)),
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env }, // inherit the test's throwaway CAIRN_DB_PATH (preload)
  });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return out.trim();
}

test("PreToolUse on a brain write injects the format and ALLOWS", async () => {
  const out = await fire({ hook_event_name: "PreToolUse", tool_name: "brain_create", tool_input: { text: "anything" } });
  const j = JSON.parse(out);
  expect(j.hookSpecificOutput.permissionDecision).toBe("allow");
  expect(j.hookSpecificOutput.additionalContext).toContain("terse");
});

test("NO length limit — a 5000-char entry is still allowed, never rejected", async () => {
  const out = await fire({ hook_event_name: "PreToolUse", tool_name: "mcp__cairn__brain_mutate", tool_input: { id: "1", answer: "y".repeat(5000) } });
  expect(JSON.parse(out).hookSpecificOutput.permissionDecision).toBe("allow");
});

test("PreToolUse does not inject on brain_search (a read, not a write)", async () => {
  const out = await fire({ hook_event_name: "PreToolUse", tool_name: "brain_search", tool_input: { query: "x" } });
  expect(out).toBe("");
});

test("PreToolUse ignores non-brain tools", async () => {
  const out = await fire({ hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: "x" } });
  expect(out).toBe("");
});

test("PreToolUse DENIES a new root-only branch while an open branch exists", async () => {
  const DB = await import("../src/core/db");
  const N = await import("../src/core/neurons");
  DB.db().run("DELETE FROM neurons");
  const root = await N.create("root question");
  await N.create("open child", [root.id]); // unanswered -> open branch
  const out = await fire({ hook_event_name: "PreToolUse", tool_name: "brain_create", tool_input: { text: "another", edges: [root.id] } });
  expect(JSON.parse(out).hookSpecificOutput.permissionDecision).toBe("deny");
});

test("PreToolUse DENIES a yes/no question title and asks for how/why", async () => {
  const out = await fire({ hook_event_name: "PreToolUse", tool_name: "brain_create", tool_input: { text: "Does compression distinguish great poems?" } });
  const j = JSON.parse(out);
  expect(j.hookSpecificOutput.permissionDecision).toBe("deny");
  expect(j.hookSpecificOutput.permissionDecisionReason).toContain("how or why");
});

test("PreToolUse ALLOWS an open how/why question", async () => {
  const out = await fire({ hook_event_name: "PreToolUse", tool_name: "brain_create", tool_input: { text: "How does compression distinguish great poems?" } });
  expect(JSON.parse(out).hookSpecificOutput.permissionDecision).toBe("allow");
});

test("PostToolUse praises depth (non-root parent), not a flat root-child", async () => {
  const DB = await import("../src/core/db");
  const N = await import("../src/core/neurons");
  DB.db().run("DELETE FROM neurons");
  const root = await N.create("root");
  const child = await N.create("child", [root.id]);

  const deep = await fire({ hook_event_name: "PostToolUse", tool_name: "brain_create", tool_input: { text: "grandchild", edges: [child.id] }, tool_output: {} });
  expect(JSON.parse(deep).hookSpecificOutput.additionalContext).toContain("a level deeper");

  const flat = await fire({ hook_event_name: "PostToolUse", tool_name: "brain_create", tool_input: { text: "root child", edges: [root.id] }, tool_output: {} });
  expect(JSON.parse(flat).hookSpecificOutput.additionalContext).not.toContain("a level deeper");
});
