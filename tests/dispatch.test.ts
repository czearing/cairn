// End-to-end: spawn the REAL hook with a payload on stdin, exactly as Claude Code invokes it.
// Proves the entry-format prompt is injected when a write tool is called — with NO rejection
// and NO length limit.
import { beforeAll, test, expect } from "bun:test";
import { randomUUID } from "node:crypto";
import { rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

beforeAll(async () => {
  (await import("../src/core/db")).db();
});

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

test("PreToolUse no longer judges question phrasing — a yes/no title is allowed (the model decides)", async () => {
  const out = await fire({ hook_event_name: "PreToolUse", tool_name: "brain_create", tool_input: { text: "Does compression distinguish great poems?" } });
  expect(JSON.parse(out).hookSpecificOutput.permissionDecision).toBe("allow");
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

test("Claude delegates only skills selected in host-owned lifecycle state", async () => {
  const { putSkill } = await import("../src/skill/store");
  const skillId = randomUUID();
  const sessionId = `claude-delegation-${randomUUID()}`;
  putSkill({
    id: skillId,
    task: "poetry writing",
    masterPrompt: "1. Draft three lines",
    description: "Use for poems.",
    ts: 1,
  }, [1, 0]);
  await fire({
    hook_event_name: "PostToolUse",
    session_id: sessionId,
    tool_name: "skill_select",
    tool_input: { ids: [skillId] },
    tool_output: {},
  });
  const out = await fire({
    hook_event_name: "PreToolUse",
    session_id: sessionId,
    tool_use_id: "claude-task-1",
    tool_name: "Task",
    tool_input: { prompt: `CAIRN_SKILL_IDS: ${skillId}\nWrite a haiku.` },
  });
  expect(JSON.parse(out).hookSpecificOutput.updatedInput.prompt).toContain(`Selected skill: poetry writing (${skillId})`);
});

test("Claude accepts a host-native Skill invocation without requiring a Cairn selection", async () => {
  const sessionId = `claude-native-skill-${randomUUID()}`;
  await fire({
    hook_event_name: "PostToolUse",
    session_id: sessionId,
    tool_name: "Skill",
    tool_input: { skill: "cairn-harness" },
    tool_output: { ok: true },
  });
  expect(await fire({
    hook_event_name: "PreToolUse",
    session_id: sessionId,
    tool_name: "Bash",
    tool_input: { command: "echo ready" },
  })).toBe("");
});

test("Claude fails open when a resumed model manifest exposes no Cairn tools", async () => {
  const sessionId = `claude-stale-manifest-${randomUUID()}`;
  const transcriptPath = join(tmpdir(), `${sessionId}.jsonl`);
  writeFileSync(transcriptPath, "");
  const previous = process.env.CAIRN_ENFORCE_STOP_GATES;
  process.env.CAIRN_ENFORCE_STOP_GATES = "0";
  const stop = JSON.parse(await fire({
      hook_event_name: "Stop",
      session_id: sessionId,
      transcript_path: transcriptPath,
    }));
  if (previous == null) delete process.env.CAIRN_ENFORCE_STOP_GATES;
  else process.env.CAIRN_ENFORCE_STOP_GATES = previous;
  expect(stop.reason).toContain("completed every requested task");
  expect(stop.reason).not.toContain("brain");
  expect(stop.reason).not.toContain("skill");
  rmSync(transcriptPath, { force: true });
});

test("Claude Stop defers automatic skill review until all stop gates pass", async () => {
  const { listReviewJobs } = await import("../src/skill/review-queue");
  const skillId = randomUUID();
  const sessionId = `claude-auto-review-${randomUUID()}`;
  const transcriptPath = join(tmpdir(), `${sessionId}.jsonl`);
  writeFileSync(
    transcriptPath,
    [
      JSON.stringify({ type: "user", message: { content: "Fix the bug." } }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "The bug is fixed." }] } }),
    ].join("\n") + "\n"
  );
  await fire({
    hook_event_name: "PostToolUse",
    session_id: sessionId,
    tool_name: "skill_select",
    tool_input: { ids: [skillId] },
    tool_output: {},
  });

  const blocked = JSON.parse(await fire({
    hook_event_name: "Stop",
    session_id: sessionId,
    transcript_path: transcriptPath,
  }));
  expect(blocked.reason).toContain("brain");
  expect(blocked.reason).toContain("completed every requested task");
  expect(listReviewJobs().filter((job) => job.sessionId === sessionId)).toHaveLength(0);

  writeFileSync(
    transcriptPath,
    [
      JSON.stringify({ type: "user", message: { content: "Fix the bug." } }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "brain_search", input: { query: "bug" } }] } }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "The bug is fixed." }] } }),
    ].join("\n") + "\n"
  );
  expect(await fire({
    hook_event_name: "Stop",
    session_id: sessionId,
    transcript_path: transcriptPath,
    stop_hook_active: true,
  })).toBe("");
  expect(listReviewJobs().filter((job) => job.sessionId === sessionId)).toEqual([
    expect.objectContaining({
      skillId,
      transcriptPath: expect.stringContaining(join(process.env.CAIRN_INFLIGHT_DIR!, "reviews")),
      backend: "claude-auto",
      status: "pending",
    }),
  ]);
  rmSync(transcriptPath, { force: true });
});

test("Claude legacy skill_review declarations are queued only at terminal Stop", async () => {
  const { listReviewJobs } = await import("../src/skill/review-queue");
  const skillId = randomUUID();
  const sessionId = `claude-legacy-review-${randomUUID()}`;
  const transcriptPath = join(tmpdir(), `${sessionId}.jsonl`);
  writeFileSync(
    transcriptPath,
    [
      JSON.stringify({ type: "user", message: { content: "Fix the bug." } }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "brain_search", input: { query: "bug" } }] } }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "The bug is fixed." }] } }),
    ].join("\n") + "\n"
  );
  await fire({
    hook_event_name: "PostToolUse",
    session_id: sessionId,
    tool_name: "skill_review",
    tool_input: { id: skillId },
    tool_output: { ok: true },
  });
  expect(listReviewJobs().filter((job) => job.sessionId === sessionId)).toHaveLength(0);

  const completion = JSON.parse(await fire({
    hook_event_name: "Stop",
    session_id: sessionId,
    transcript_path: transcriptPath,
  }));
  expect(completion.reason).toContain("completed every requested task");
  expect(listReviewJobs().filter((job) => job.sessionId === sessionId)).toHaveLength(0);
  expect(await fire({
    hook_event_name: "Stop",
    session_id: sessionId,
    transcript_path: transcriptPath,
    stop_hook_active: true,
  })).toBe("");
  expect(listReviewJobs().filter((job) => job.sessionId === sessionId)).toEqual([
    expect.objectContaining({ skillId, backend: "claude-auto", status: "pending" }),
  ]);
  rmSync(transcriptPath, { force: true });
});
