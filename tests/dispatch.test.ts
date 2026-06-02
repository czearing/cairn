// End-to-end: spawn the REAL hook with a payload on stdin, exactly as Claude Code invokes it.
// Proves the entry-format enforcement fires at the right moment (PreToolUse, before the write)
// with the right decision.
import { test, expect } from "bun:test";

async function fire(payload: object): Promise<string> {
  const proc = Bun.spawn(["bun", "src/hosts/claude-code/dispatch.ts"], {
    stdin: new TextEncoder().encode(JSON.stringify(payload)),
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return out.trim();
}

const verbose = "x".repeat(500);

test("PreToolUse DENIES a verbose brain_create before it writes", async () => {
  const out = await fire({ hook_event_name: "PreToolUse", tool_name: "brain_create", tool_input: { text: verbose } });
  const j = JSON.parse(out);
  expect(j.hookSpecificOutput.permissionDecision).toBe("deny");
  expect(j.hookSpecificOutput.permissionDecisionReason).toContain("too verbose");
  expect(j.hookSpecificOutput.permissionDecisionReason).toContain("500 chars");
});

test("PreToolUse DENIES a verbose namespaced brain_mutate", async () => {
  const out = await fire({ hook_event_name: "PreToolUse", tool_name: "mcp__cairn__brain_mutate", tool_input: { id: "1", answer: "y".repeat(800) } });
  expect(JSON.parse(out).hookSpecificOutput.permissionDecision).toBe("deny");
});

test("PreToolUse ALLOWS a terse brain_create (no output, no friction)", async () => {
  const out = await fire({ hook_event_name: "PreToolUse", tool_name: "brain_create", tool_input: { text: "How do I write a haiku?" } });
  expect(out).toBe("");
});

test("PreToolUse ignores non-brain tools", async () => {
  const out = await fire({ hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: verbose } });
  expect(out).toBe("");
});
