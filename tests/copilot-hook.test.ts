import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  gateDecision,
  eventsPathForSession,
  harnessStopDecision,
  internalContext,
  isTool,
  postToolFiles,
  STOP_CAP,
  shouldStartUserTurn,
  stopDecision,
} from "../src/hosts/copilot-cli/hook";

function reviewJobs(dbPath: string): { skill_id: string; status?: string }[] {
  const database = new Database(dbPath);
  try {
    const table = database.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'review_jobs'").get();
    return table ? database.query("SELECT skill_id, status FROM review_jobs").all() as { skill_id: string; status: string }[] : [];
  } finally {
    database.close();
  }
}

function lifecycleState(dbPath: string, scope: string): { pendingReviewIds: string[]; pendingReviews: unknown[] } {
  const database = new Database(dbPath);
  try {
    const row = database.query("SELECT pending_review_ids, pending_reviews FROM lifecycle_turns WHERE scope = ?")
      .get(scope) as { pending_review_ids: string; pending_reviews: string };
    return {
      pendingReviewIds: JSON.parse(row.pending_review_ids),
      pendingReviews: JSON.parse(row.pending_reviews),
    };
  } finally {
    database.close();
  }
}

// ── postToolFiles: which prompts a COMPLETED Copilot tool delivers, mirroring Claude's after-tool set ──

test("postToolFiles returns the search reminder for a brain_search", () => {
  expect(postToolFiles("cairn-brain_search", "")).toEqual(["search-results.md"]);
});

test("postToolFiles delivers entry-format BEFORE the create/mutate reminder (Claude parity)", () => {
  expect(postToolFiles("cairn-brain_create", "")).toEqual(["entry-format.md", "node-created.md"]);
  expect(postToolFiles("cairn-brain_mutate", "an answer")).toEqual(["entry-format.md", "answer-check.md"]); // answer set → split-check
  expect(postToolFiles("cairn-brain_mutate", "")).toEqual(["entry-format.md", "node-modified.md"]); // plain edit (node-modified is empty → dropped by caller)
});

test("postToolFiles delivers orchestrate BEFORE subtask-spawned for a subagent spawn", () => {
  expect(postToolFiles("task", "")).toEqual(["orchestrate.md", "subtask-spawned.md"]);
  expect(postToolFiles("Task", "")).toEqual(["orchestrate.md", "subtask-spawned.md"]);
  expect(postToolFiles("Agent", "")).toEqual(["orchestrate.md", "subtask-spawned.md"]);
});

test("postToolFiles is empty for unrelated tools", () => {
  expect(postToolFiles("view", "")).toEqual([]);
  expect(postToolFiles("bash", "")).toEqual([]);
});

// ── stopDecision: the agentStop gate, bounded so it can never loop forever ────────────────────────

test("stopDecision requires skill selection before brain use", () => {
  expect(stopDecision({ brainUsed: false, skillUsed: false, pendingReviewCount: 0, stopNudges: 0 })).toEqual({ file: "skill-search-reminder.md" });
});

test("stopDecision nudges skill-review while selected skills remain pending", () => {
  expect(stopDecision({ brainUsed: true, skillUsed: true, pendingReviewCount: 2, stopNudges: 0 })).toEqual({ file: "skill-review.md" });
});

test("stopDecision allows the turn to end when every selected skill was reviewed", () => {
  expect(stopDecision({ brainUsed: true, skillUsed: true, pendingReviewCount: 0, stopNudges: 0 })).toEqual({ file: "" });
});

test("stopDecision requires skill selection even when the brain was used", () => {
  expect(stopDecision({ brainUsed: true, skillUsed: false, pendingReviewCount: 0, stopNudges: 0 })).toEqual({ file: "skill-search-reminder.md" });
});

test("stopDecision stops nudging once the per-turn cap is reached (no infinite loop)", () => {
  expect(stopDecision({ brainUsed: false, skillUsed: true, pendingReviewCount: 1, stopNudges: STOP_CAP })).toEqual({ file: "" });
});

test("harness stop requires skill lifecycle but not brain use", () => {
  expect(harnessStopDecision({ skillUsed: false, pendingReviewCount: 0, stopNudges: 0 })).toEqual({ file: "skill-search-reminder.md" });
  expect(harnessStopDecision({ skillUsed: true, pendingReviewCount: 1, stopNudges: 0 })).toEqual({ file: "skill-review.md" });
  expect(harnessStopDecision({ skillUsed: true, pendingReviewCount: 0, stopNudges: 0 })).toEqual({ file: "" });
});

test("user-prompt reset runs only for real human prompts", () => {
  expect(shouldStartUserTurn("fix the component")).toBe(true);
  expect(shouldStartUserTurn(
    "<cairn-internal>You are ending a turn</cairn-internal>",
  )).toBe(false);
  expect(shouldStartUserTurn(
    "<system_reminder>check todos</system_reminder>",
  )).toBe(false);
});

// ── gateDecision: the preToolUse brain_create gate (pure; deps injected) ──────────────────────────

test("gateDecision denies a node linked only to the root while open branches remain", () => {
  const d = gateDecision("cairn-brain_create", { text: "How does X work?", edges: ["r"] }, { rootId: "r", openBranch: true });
  expect(d.deny).toBe(true);
  expect(d.reason).toContain("root already has open branches");
});

test("gateDecision allows a deeper node (linked under a non-root parent)", () => {
  const d = gateDecision("cairn-brain_create", { text: "How does X work?", edges: ["child"] }, { rootId: "r", openBranch: true });
  expect(d.deny).toBe(false);
});

test("gateDecision allows a root-child when no open branches remain", () => {
  const d = gateDecision("cairn-brain_create", { text: "How does X work?", edges: ["r"] }, { rootId: "r", openBranch: false });
  expect(d.deny).toBe(false);
});

test("gateDecision never gates a non-create tool", () => {
  expect(gateDecision("cairn-brain_mutate", { text: "x" }, { rootId: "r", openBranch: true }).deny).toBe(false);
  expect(gateDecision("cairn-brain_search", { text: "x" }, { rootId: "r", openBranch: true }).deny).toBe(false);
});

// ── isTool: accepts bare, hyphen-prefixed, and __-namespaced forms ────────────────────────────────

test("isTool matches across naming conventions", () => {
  expect(isTool("brain_search", "brain_search")).toBe(true);
  expect(isTool("cairn-brain_search", "brain_search")).toBe(true);
  expect(isTool("mcp__cairn__brain_search", "brain_search")).toBe(true);
  expect(isTool("view", "brain_search")).toBe(false);
});

test("internalContext gives injected reminders one structural envelope", () => {
  expect(internalContext("remember this")).toBe("<cairn-internal>\nremember this\n</cairn-internal>");
  expect(internalContext("")).toBe("");
});

test("eventsPathForSession honors isolated COPILOT_HOME", () => {
  const previous = process.env.COPILOT_HOME;
  process.env.COPILOT_HOME = "C:\\isolated";
  expect(eventsPathForSession("abc")).toBe(join("C:\\isolated", "session-state", "abc", "events.jsonl"));
  if (previous === undefined) delete process.env.COPILOT_HOME;
  else process.env.COPILOT_HOME = previous;
});

test("subagentStop durably queues the subagent's latest skill_review", () => {
  const id = randomUUID();
  const dbPath = join(tmpdir(), `cairn-review-hook-${id}.db`);
  const home = join(tmpdir(), `cairn-review-hook-home-${id}`);
  const transcriptPath = join(tmpdir(), `cairn-review-hook-${id}.jsonl`);
  writeFileSync(transcriptPath, [
    JSON.stringify({ type: "subagent.started", agentId: "agent-1", timestamp: 10, data: { agentName: "code-review", agentDisplayName: "Reviewer" } }),
    JSON.stringify({ type: "assistant.message", agentId: "agent-1", timestamp: 11, data: { content: "Finished review." } }),
    JSON.stringify({ type: "tool.execution_start", agentId: "agent-1", timestamp: 12, data: { toolCallId: "review-1", toolName: "cairn-skill_review", arguments: { id: "skill-1" } } }),
    JSON.stringify({ type: "tool.execution_complete", agentId: "agent-1", timestamp: 13, data: { toolCallId: "review-1", success: true } }),
    JSON.stringify({ type: "tool.execution_start", agentId: "agent-1", timestamp: 14, data: { toolCallId: "review-2", toolName: "cairn-skill_review", arguments: { id: "skill-2" } } }),
    JSON.stringify({ type: "tool.execution_complete", agentId: "agent-1", timestamp: 15, data: { toolCallId: "review-2", success: true } }),
  ].join("\n"));
  const hook = join(import.meta.dir, "..", "src", "hosts", "copilot-cli", "hook.ts");
  const env = { ...process.env, USERPROFILE: home, HOME: home, CAIRN_DB_PATH: dbPath, CAIRN_MAX_LEARNERS: "0", CAIRN_SKILLS: "1" };
  const invoke = (mode: string, payload: object) => spawnSync(process.execPath, [hook, mode], { input: JSON.stringify(payload), env });
  expect(invoke("post-tool", { sessionId: "session-1", toolName: "cairn-brain_search", toolArgs: {} }).status).toBe(0);
  expect(invoke("post-tool", { sessionId: "session-1", toolName: "cairn-skill_select", toolArgs: { ids: ["parent-skill"] } }).status).toBe(0);
  expect(invoke("post-tool", { sessionId: "session-1", agentId: "agent-1", toolName: "cairn-brain_search", toolArgs: {} }).status).toBe(0);
  expect(invoke("post-tool", { sessionId: "session-1", agentId: "agent-1", toolName: "cairn-skill_select", toolArgs: { ids: ["skill-1", "skill-2"] } }).status).toBe(0);
  expect(invoke("post-tool", { sessionId: "session-1", agentId: "agent-1", timestamp: 12, toolName: "cairn-skill_review", toolArgs: { id: "skill-1" } }).status).toBe(0);
  expect(invoke("post-tool", { sessionId: "session-1", agentId: "agent-1", timestamp: 14, toolName: "cairn-skill_review", toolArgs: { id: "skill-2" } }).status).toBe(0);
  const run = invoke("subagent-stop", { sessionId: "session-1", agentName: "code-review", transcriptPath });
  expect(run.status).toBe(0);
  const d = new Database(dbPath);
  const jobs = d.query("SELECT skill_id, status FROM review_jobs").all() as { skill_id: string; status: string }[];
  d.close();
  expect(jobs.map((job) => job.skill_id).sort()).toEqual(["skill-1", "skill-2"]);
  const parentState = lifecycleState(dbPath, "copilot:session-1");
  expect(parentState.pendingReviewIds).toEqual(["parent-skill"]);
  expect(invoke("agent-stop", { sessionId: "session-1" }).stdout.toString()).toContain('"decision":"block"');
});

test("subagentStop resolves the stopping agent id when same-name reviews interleave", () => {
  const id = randomUUID();
  const dbPath = join(tmpdir(), `cairn-review-identity-${id}.db`);
  const home = join(tmpdir(), `cairn-review-identity-home-${id}`);
  const transcriptPath = join(tmpdir(), `cairn-review-identity-${id}.jsonl`);
  writeFileSync(transcriptPath, [
    JSON.stringify({ type: "subagent.started", agentId: "agent-a", timestamp: 10, data: { agentName: "code-review" } }),
    JSON.stringify({ type: "subagent.started", agentId: "agent-b", timestamp: 11, data: { agentName: "code-review" } }),
    JSON.stringify({ type: "tool.execution_start", agentId: "agent-a", timestamp: 12, data: { toolCallId: "review-a", toolName: "cairn-skill_review", arguments: { id: "skill-a" } } }),
    JSON.stringify({ type: "tool.execution_complete", agentId: "agent-a", timestamp: 13, data: { toolCallId: "review-a", success: true } }),
    JSON.stringify({ type: "tool.execution_start", agentId: "agent-b", timestamp: 14, data: { toolCallId: "review-b", toolName: "cairn-skill_review", arguments: { id: "skill-b" } } }),
    JSON.stringify({ type: "tool.execution_complete", agentId: "agent-b", timestamp: 15, data: { toolCallId: "review-b", success: true } }),
    JSON.stringify({ type: "assistant.message", agentId: "agent-a", timestamp: 16, data: { content: "Agent A finished." } }),
  ].join("\n"));
  const hook = join(import.meta.dir, "..", "src", "hosts", "copilot-cli", "hook.ts");
  const env = { ...process.env, USERPROFILE: home, HOME: home, CAIRN_DB_PATH: dbPath, CAIRN_MAX_LEARNERS: "0", CAIRN_SKILLS: "1" };
  const invoke = (payload: object) => spawnSync(process.execPath, [hook, "post-tool"], { input: JSON.stringify(payload), env });
  expect(invoke({ sessionId: "session-identity", agentId: "agent-a", toolName: "cairn-brain_search", toolArgs: {} }).status).toBe(0);
  expect(invoke({ sessionId: "session-identity", agentId: "agent-a", toolName: "cairn-skill_select", toolArgs: { ids: ["skill-a"] } }).status).toBe(0);
  expect(invoke({ sessionId: "session-identity", agentId: "agent-a", timestamp: 12, toolName: "cairn-skill_review", toolArgs: { id: "skill-a" } }).status).toBe(0);
  const run = spawnSync(process.execPath, [hook, "subagent-stop"], {
    input: JSON.stringify({ sessionId: "session-identity", agentName: "code-review", transcriptPath }),
    env,
  });
  expect(run.status).toBe(0);
  expect(reviewJobs(dbPath)).toEqual([{ skill_id: "skill-a", status: "pending" }]);
});

test("preToolUse prepends the Cairn protocol for general-purpose agents", () => {
  const id = randomUUID();
  const home = join(tmpdir(), `cairn-general-purpose-home-${id}`);
  const hook = join(import.meta.dir, "..", "src", "hosts", "copilot-cli", "hook.ts");
  const run = spawnSync(process.execPath, [hook, "pre-tool"], {
    input: JSON.stringify({
      sessionId: "session-general",
      toolName: "task",
      toolArgs: { agent_type: "general-purpose", prompt: "Review this change." },
    }),
    env: { ...process.env, USERPROFILE: home, HOME: home },
  });
  expect(run.status).toBe(0);
  const output = JSON.parse(run.stdout.toString()) as { modifiedArgs: { prompt: string } };
  expect(output.modifiedArgs.prompt).toContain("CAIRN_SKILL_IDS");
  expect(output.modifiedArgs.prompt).toEndWith("Review this change.");
});

test("preToolUse injects parent-selected skill steps into a delegated Task prompt", () => {
  const id = randomUUID();
  const skillId = randomUUID();
  const home = join(tmpdir(), `cairn-delegated-skill-home-${id}`);
  const dbPath = join(tmpdir(), `cairn-delegated-skill-${id}.db`);
  const hook = join(import.meta.dir, "..", "src", "hosts", "copilot-cli", "hook.ts");
  const seed = spawnSync(process.execPath, ["-e", `
      import { putSkill } from ${JSON.stringify(join(import.meta.dir, "..", "src", "skill", "store.ts"))};
      putSkill({ id: ${JSON.stringify(skillId)}, task: "poetry writing", masterPrompt: "1. Draft three lines\\n2. Verify the form", description: "Use for poems.", ts: 1 }, [1, 0]);
    `], { env: { ...process.env, CAIRN_DB_PATH: dbPath } });
  expect(seed.status).toBe(0);
  expect(spawnSync(process.execPath, [hook, "post-tool"], {
    input: JSON.stringify({ sessionId: "session-delegated", toolName: "cairn-skill_select", toolArgs: { ids: [skillId] } }),
    env: { ...process.env, USERPROFILE: home, HOME: home, CAIRN_DB_PATH: dbPath },
  }).status).toBe(0);
  const run = spawnSync(process.execPath, [hook, "pre-tool"], {
    input: JSON.stringify({
      sessionId: "session-delegated",
      toolCallId: "call-delegated",
      toolName: "task",
      toolArgs: {
        agent_type: "explore",
        prompt: `CAIRN_SKILL_IDS: ${skillId}\nWrite a haiku.`,
      },
    }),
    env: { ...process.env, USERPROFILE: home, HOME: home, CAIRN_DB_PATH: dbPath },
  });
  expect(run.status).toBe(0);
  const output = JSON.parse(run.stdout.toString()) as { modifiedArgs: { prompt: string } };
  expect(output.modifiedArgs.prompt).toContain(`## Selected skill: poetry writing (${skillId})`);
  expect(output.modifiedArgs.prompt).toContain("1. Draft three lines");
  expect(output.modifiedArgs.prompt).toEndWith("Write a haiku.");
});

test("preToolUse parses Copilot's real toolCalls batch payload", () => {
  const id = randomUUID();
  const skillId = randomUUID();
  const home = join(tmpdir(), `cairn-tool-calls-home-${id}`);
  const dbPath = join(tmpdir(), `cairn-tool-calls-${id}.db`);
  const hook = join(import.meta.dir, "..", "src", "hosts", "copilot-cli", "hook.ts");
  const seed = spawnSync(process.execPath, ["-e", `
    import { putSkill } from ${JSON.stringify(join(import.meta.dir, "..", "src", "skill", "store.ts"))};
    putSkill({ id: ${JSON.stringify(skillId)}, task: "poetry writing", masterPrompt: "1. Draft three lines", description: "Use for poems.", ts: 1 }, [1, 0]);
  `], { env: { ...process.env, CAIRN_DB_PATH: dbPath } });
  expect(seed.status).toBe(0);
  expect(spawnSync(process.execPath, [hook, "post-tool"], {
    input: JSON.stringify({ sessionId: "session-batch", toolName: "cairn-skill_select", toolArgs: { ids: [skillId] } }),
    env: { ...process.env, USERPROFILE: home, HOME: home, CAIRN_DB_PATH: dbPath },
  }).status).toBe(0);
  const args = { agent_type: "explore", prompt: `CAIRN_SKILL_IDS: ${skillId}\nWrite a haiku.` };
  const run = spawnSync(process.execPath, [hook, "pre-tool"], {
    input: JSON.stringify({
      sessionId: "session-batch",
      toolCalls: [{ id: "call-1", name: "task", args: JSON.stringify(args) }],
    }),
    env: { ...process.env, USERPROFILE: home, HOME: home, CAIRN_DB_PATH: dbPath },
  });
  const output = JSON.parse(run.stdout.toString()) as { modifiedArgs: { prompt: string } };
  expect(output.modifiedArgs.prompt).toContain("## Selected skill: poetry writing");
});

test("skill_select requires one review declaration per selected skill", () => {
  const id = randomUUID();
  const home = join(tmpdir(), `cairn-multi-skill-home-${id}`);
  const dbPath = join(tmpdir(), `cairn-multi-skill-${id}.db`);
  const hook = join(import.meta.dir, "..", "src", "hosts", "copilot-cli", "hook.ts");
  const env = { ...process.env, USERPROFILE: home, HOME: home, CAIRN_DB_PATH: dbPath, CAIRN_SKILLS: "1" };
  const invoke = (payload: object) => spawnSync(process.execPath, [hook, "post-tool"], { input: JSON.stringify(payload), env });

  expect(invoke({ sessionId: "session-multi", toolName: "cairn-skill_select", toolArgs: { ids: ["skill-a", "skill-b"] } }).status).toBe(0);
  expect(lifecycleState(dbPath, "copilot:session-multi").pendingReviewIds).toEqual(["skill-a", "skill-b"]);
  expect(invoke({ sessionId: "session-multi", toolName: "cairn-brain_search", toolArgs: {} }).status).toBe(0);
  const reminder = spawnSync(process.execPath, [hook, "agent-stop"], {
    input: JSON.stringify({ sessionId: "session-multi" }),
    env,
  }).stdout.toString();
  expect(reminder).toContain("Pending exact skill ids: skill-a, skill-b");
  expect(invoke({ sessionId: "session-multi", timestamp: 20, toolName: "cairn-skill_review", toolArgs: { id: "skill-a" } }).status).toBe(0);
  expect(lifecycleState(dbPath, "copilot:session-multi").pendingReviewIds).toEqual(["skill-b"]);
  expect(invoke({ sessionId: "session-multi", timestamp: 21, toolName: "cairn-skill_review", toolArgs: { id: "skill-b" } }).status).toBe(0);
  const state = lifecycleState(dbPath, "copilot:session-multi");
  expect(state.pendingReviewIds).toEqual([]);
  expect(state.pendingReviews).toHaveLength(2);
});

test("review reminders never expose legacy placeholder ids as exact targets", () => {
  const id = randomUUID();
  const dbPath = join(tmpdir(), `cairn-legacy-reminder-${id}.db`);
  const hook = join(import.meta.dir, "..", "src", "hosts", "copilot-cli", "hook.ts");
  const env = { ...process.env, CAIRN_DB_PATH: dbPath, CAIRN_SKILLS: "1" };
  const invoke = (mode: string, payload: object) =>
    spawnSync(process.execPath, [hook, mode], { input: JSON.stringify(payload), env });
  expect(invoke("post-tool", {
    sessionId: "legacy-reminder",
    toolName: "cairn-skill_search",
    toolArgs: { task: "legacy" },
  }).status).toBe(0);
  expect(invoke("post-tool", {
    sessionId: "legacy-reminder",
    toolName: "cairn-brain_search",
    toolArgs: {},
  }).status).toBe(0);
  const reminder = invoke("agent-stop", { sessionId: "legacy-reminder" }).stdout.toString();
  expect(reminder).toContain("skill_review");
  expect(reminder).not.toContain("__legacy__");
  expect(reminder).not.toContain("Pending exact skill ids:");
});

test("postToolUse records the exact created skill id from the tool result", () => {
  const id = randomUUID();
  const home = join(tmpdir(), `cairn-created-skill-home-${id}`);
  const dbPath = join(tmpdir(), `cairn-created-skill-${id}.db`);
  const hook = join(import.meta.dir, "..", "src", "hosts", "copilot-cli", "hook.ts");
  const run = spawnSync(process.execPath, [hook, "post-tool"], {
    input: JSON.stringify({
      sessionId: "session-created",
      toolName: "cairn-skill_create",
      toolArgs: { title: "api debugging" },
      toolResult: { textResultForLlm: '{"created":true,"id":"created-skill"}' },
    }),
    env: { ...process.env, USERPROFILE: home, HOME: home, CAIRN_DB_PATH: dbPath, CAIRN_SKILLS: "1" },
  });
  expect(run.status).toBe(0);
  const state = lifecycleState(dbPath, "copilot:session-created");
  expect(state.pendingReviewIds).toEqual(["created-skill"]);
});

test("successful skill_review is declared at postToolUse and queued after the final answer at agentStop", () => {
  const id = randomUUID();
  const dbPath = join(tmpdir(), `cairn-review-stop-${id}.db`);
  const home = join(tmpdir(), `cairn-review-home-${id}`);
  const transcriptPath = join(home, ".copilot", "session-state", "session-2", "events.jsonl");
  mkdirSync(join(home, ".copilot", "session-state", "session-2"), { recursive: true });
  writeFileSync(transcriptPath, [
    JSON.stringify({ type: "user.message", id: "user-1", timestamp: 10, data: { content: "Fix the lifecycle." } }),
    JSON.stringify({ type: "assistant.message", timestamp: 15, data: { content: "I am checking it." } }),
    JSON.stringify({
      type: "tool.execution_start",
      timestamp: 20,
      data: { toolCallId: "review-2", toolName: "cairn-skill_review", arguments: { id: "skill-2" } },
    }),
  ].join("\n"));
  const hook = join(import.meta.dir, "..", "src", "hosts", "copilot-cli", "hook.ts");
  const env = { ...process.env, USERPROFILE: home, HOME: home, CAIRN_DB_PATH: dbPath, CAIRN_MAX_LEARNERS: "0", CAIRN_SKILLS: "1" };
  const invoke = (mode: string, payload: object) => spawnSync(process.execPath, [hook, mode], { input: JSON.stringify(payload), env });

  expect(invoke("post-tool", { sessionId: "session-2", toolName: "cairn-brain_search", toolArgs: {} }).status).toBe(0);
  const reviewPayload = {
    sessionId: "session-2",
    timestamp: 21,
    toolName: "cairn-skill_review",
    toolArgs: { id: "skill-2" },
  };
  expect(invoke("post-tool", reviewPayload).status).toBe(0);
  expect(invoke("post-tool", reviewPayload).status).toBe(0);
  expect(reviewJobs(dbPath)).toEqual([]);
  writeFileSync(transcriptPath, [
    JSON.stringify({ type: "user.message", id: "user-1", timestamp: 10, data: { content: "Fix the lifecycle." } }),
    JSON.stringify({ type: "assistant.message", timestamp: 15, data: { content: "I am checking it." } }),
    JSON.stringify({
      type: "tool.execution_start",
      timestamp: 20,
      data: { toolCallId: "review-2", toolName: "cairn-skill_review", arguments: { id: "skill-2" } },
    }),
    JSON.stringify({ type: "tool.execution_complete", timestamp: 22, data: { toolCallId: "review-2", success: true } }),
    JSON.stringify({ type: "assistant.message", timestamp: 25, data: { content: "The lifecycle is fixed." } }),
  ].join("\n"));
  const stop = invoke("agent-stop", { sessionId: "session-2" });
  expect(stop.status).toBe(0);
  expect(stop.stdout.toString()).toBe("{}");
  expect(reviewJobs(dbPath)).toEqual([{ skill_id: "skill-2", status: "pending" }]);
});

test("a premature skill_review waits for the visible deliverable before queueing", () => {
  const id = randomUUID();
  const dbPath = join(tmpdir(), `cairn-premature-review-${id}.db`);
  const home = join(tmpdir(), `cairn-premature-review-home-${id}`);
  const transcriptPath = join(home, ".copilot", "session-state", "premature", "events.jsonl");
  mkdirSync(join(home, ".copilot", "session-state", "premature"), { recursive: true });
  const reviewEvents = [
    JSON.stringify({ type: "user.message", timestamp: 1, data: { content: "Complete the assigned task." } }),
    JSON.stringify({ type: "tool.execution_start", timestamp: 2, data: {
      toolCallId: "premature-review",
      toolName: "cairn-skill_review",
      arguments: { id: "skill-premature" },
    } }),
    JSON.stringify({ type: "tool.execution_complete", timestamp: 3, data: {
      toolCallId: "premature-review",
      success: true,
    } }),
  ];
  writeFileSync(transcriptPath, reviewEvents.join("\n"));
  const hook = join(import.meta.dir, "..", "src", "hosts", "copilot-cli", "hook.ts");
  const env = {
    ...process.env,
    USERPROFILE: home,
    HOME: home,
    CAIRN_DB_PATH: dbPath,
    CAIRN_MAX_LEARNERS: "0",
    CAIRN_SKILLS: "1",
  };
  const invoke = (mode: string, payload: object) =>
    spawnSync(process.execPath, [hook, mode], { input: JSON.stringify(payload), env });
  expect(invoke("post-tool", {
    sessionId: "premature",
    toolName: "cairn-brain_search",
    toolArgs: {},
  }).status).toBe(0);
  expect(invoke("post-tool", {
    sessionId: "premature",
    toolName: "cairn-skill_select",
    toolArgs: { ids: ["skill-premature"] },
  }).status).toBe(0);
  expect(invoke("post-tool", {
    sessionId: "premature",
    timestamp: 2,
    toolName: "cairn-skill_review",
    toolArgs: { id: "skill-premature" },
  }).status).toBe(0);
  expect(invoke("agent-stop", { sessionId: "premature", transcriptPath }).stdout.toString())
    .toContain("before a visible deliverable existed");
  expect(reviewJobs(dbPath)).toEqual([]);
  writeFileSync(transcriptPath, [
    ...reviewEvents,
    JSON.stringify({ type: "assistant.message", timestamp: 4, data: { content: "Finished result." } }),
  ].join("\n"));
  expect(invoke("agent-stop", { sessionId: "premature", transcriptPath }).stdout.toString()).toBe("{}");
  expect(reviewJobs(dbPath)).toEqual([{ skill_id: "skill-premature", status: "pending" }]);
});

test("a failed skill_review does not clear the pending lifecycle obligation", () => {
  const id = randomUUID();
  const dbPath = join(tmpdir(), `cairn-failed-review-state-${id}.db`);
  const hook = join(import.meta.dir, "..", "src", "hosts", "copilot-cli", "hook.ts");
  const env = { ...process.env, CAIRN_DB_PATH: dbPath, CAIRN_SKILLS: "1" };
  const invoke = (mode: string, payload: object) =>
    spawnSync(process.execPath, [hook, mode], { input: JSON.stringify(payload), env });
  expect(invoke("post-tool", {
    sessionId: "failed-review-state",
    toolName: "cairn-skill_select",
    toolArgs: { ids: ["skill-failed"] },
  }).status).toBe(0);
  expect(invoke("post-tool", {
    sessionId: "failed-review-state",
    timestamp: 20,
    toolName: "cairn-skill_review",
    toolArgs: { id: "skill-failed" },
    toolResult: { resultType: "failure" },
  }).status).toBe(0);
  expect(lifecycleState(dbPath, "copilot:failed-review-state").pendingReviewIds).toEqual(["skill-failed"]);
});

test("a blocked continuation defers skill learning until every stop gate passes", () => {
  const id = randomUUID();
  const dbPath = join(tmpdir(), `cairn-review-deferred-${id}.db`);
  const home = join(tmpdir(), `cairn-review-deferred-home-${id}`);
  const transcriptPath = join(home, ".copilot", "session-state", "session-3", "events.jsonl");
  mkdirSync(join(home, ".copilot", "session-state", "session-3"), { recursive: true });
  writeFileSync(transcriptPath, [
    JSON.stringify({ type: "user.message", id: "user-1", timestamp: 10, data: { content: "Audit Cairn." } }),
    JSON.stringify({ type: "tool.execution_start", timestamp: 20, data: { toolCallId: "review-3", toolName: "cairn-skill_review", arguments: { id: "skill-3" } } }),
    JSON.stringify({ type: "tool.execution_complete", timestamp: 21, data: { toolCallId: "review-3", success: true } }),
  ].join("\n"));
  const hook = join(import.meta.dir, "..", "src", "hosts", "copilot-cli", "hook.ts");
  const env = { ...process.env, USERPROFILE: home, HOME: home, CAIRN_DB_PATH: dbPath, CAIRN_MAX_LEARNERS: "0", CAIRN_SKILLS: "1" };
  const invoke = (mode: string, payload: object) => spawnSync(process.execPath, [hook, mode], { input: JSON.stringify(payload), env });

  expect(invoke("post-tool", { sessionId: "session-3", timestamp: 20, toolName: "cairn-skill_review", toolArgs: { id: "skill-3" } }).status).toBe(0);
  expect(invoke("agent-stop", { sessionId: "session-3", transcriptPath }).stdout.toString()).toContain('"decision":"block"');
  expect(reviewJobs(dbPath)).toEqual([]);

  expect(invoke("post-tool", { sessionId: "session-3", toolName: "cairn-brain_search", toolArgs: {} }).status).toBe(0);
  writeFileSync(transcriptPath, [
    JSON.stringify({ type: "user.message", id: "user-1", timestamp: 10, data: { content: "Audit Cairn." } }),
    JSON.stringify({ type: "tool.execution_start", timestamp: 20, data: { toolCallId: "review-3", toolName: "cairn-skill_review", arguments: { id: "skill-3" } } }),
    JSON.stringify({ type: "tool.execution_complete", timestamp: 21, data: { toolCallId: "review-3", success: true } }),
    JSON.stringify({ type: "assistant.message", timestamp: 30, data: { content: "Audit complete." } }),
  ].join("\n"));
  expect(invoke("agent-stop", { sessionId: "session-3", transcriptPath }).stdout.toString()).toBe("{}");
  expect(reviewJobs(dbPath)).toEqual([{ skill_id: "skill-3", status: "pending" }]);
});

test("persistent review enqueue failure respects the stop continuation cap", () => {
  const id = randomUUID();
  const home = join(tmpdir(), `cairn-review-failure-home-${id}`);
  const dbPath = join(tmpdir(), `cairn-review-failure-${id}.db`);
  const transcriptPath = join(home, ".copilot", "session-state", "session-4", "events.jsonl");
  mkdirSync(join(home, ".copilot", "session-state", "session-4"), { recursive: true });
  writeFileSync(transcriptPath, JSON.stringify({
    type: "user.message",
    id: "user-1",
    timestamp: 10,
    data: { content: "Audit Cairn." },
  }));
  const hook = join(import.meta.dir, "..", "src", "hosts", "copilot-cli", "hook.ts");
  const env = { ...process.env, USERPROFILE: home, HOME: home, CAIRN_DB_PATH: dbPath, CAIRN_SKILLS: "1" };
  const invoke = (mode: string, payload: object) => spawnSync(process.execPath, [hook, mode], { input: JSON.stringify(payload), env });

  expect(invoke("agent-stop", { sessionId: "session-4", transcriptPath }).stdout.toString()).toContain("skill_select");
  expect(invoke("post-tool", { sessionId: "session-4", timestamp: 19, toolName: "cairn-skill_select", toolArgs: { ids: ["skill-4"] } }).status).toBe(0);
  expect(invoke("agent-stop", { sessionId: "session-4", transcriptPath }).stdout.toString()).toContain("brain_search");
  expect(invoke("post-tool", { sessionId: "session-4", timestamp: 20, toolName: "cairn-brain_search", toolArgs: {} }).status).toBe(0);
  expect(invoke("post-tool", { sessionId: "session-4", timestamp: 21, toolName: "cairn-skill_review", toolArgs: { id: "skill-4" } }).status).toBe(0);
  expect(invoke("agent-stop", { sessionId: "session-4", transcriptPath: home }).stdout.toString()).toContain('"decision":"block"');
  expect(invoke("agent-stop", { sessionId: "session-4", transcriptPath: home }).stdout.toString()).toContain('"decision":"block"');
  expect(invoke("agent-stop", { sessionId: "session-4", transcriptPath: home }).stdout.toString()).toBe("{}");
});

test("system reminder prompts preserve the turn and a genuine user prompt resets it", () => {
  const id = randomUUID();
  const home = join(tmpdir(), `cairn-stop-cap-home-${id}`);
  const hook = join(import.meta.dir, "..", "src", "hosts", "copilot-cli", "hook.ts");
  const env = { ...process.env, USERPROFILE: home, HOME: home, CAIRN_SKILLS: "0" };
  const invoke = (mode: string, payload: object = { sessionId: "session-cap" }) =>
    spawnSync(process.execPath, [hook, mode], { input: JSON.stringify(payload), env });

  expect(invoke("user-prompt", { sessionId: "session-cap", prompt: "first" }).status).toBe(0);
  expect(invoke("agent-stop").stdout.toString()).toContain('"decision":"block"');
  expect(invoke("user-prompt", {
    sessionId: "session-cap",
    prompt: "<cairn-internal>continue required workflow</cairn-internal>",
  }).stdout.toString()).toBe("{}");
  expect(invoke("agent-stop").stdout.toString()).toContain('"decision":"block"');
  expect(invoke("user-prompt", {
    sessionId: "session-cap",
    prompt: "<system_reminder>continue required workflow</system_reminder>",
  }).stdout.toString()).toBe("{}");
  expect(invoke("agent-stop").stdout.toString()).toBe("{}");

  expect(invoke("user-prompt", { sessionId: "session-cap", prompt: "second" }).status).toBe(0);
  expect(invoke("agent-stop").stdout.toString()).toContain('"decision":"block"');
});

test("a queued mid-turn human message does not reset completed skill search", () => {
  const id = randomUUID();
  const home = join(tmpdir(), `cairn-queued-message-home-${id}`);
  const transcriptPath = join(home, ".copilot", "session-state", "session-queued", "events.jsonl");
  mkdirSync(join(home, ".copilot", "session-state", "session-queued"), { recursive: true });
  writeFileSync(transcriptPath, [
    JSON.stringify({ type: "user.message", id: "user-1", data: { content: "inspect skills" } }),
    JSON.stringify({ type: "user.message", id: "user-2", data: { content: "and test it" } }),
    JSON.stringify({ type: "tool.execution_start", timestamp: 30, data: {
      toolCallId: "queued-review",
      toolName: "cairn-skill_review",
      arguments: { id: "skill-queued" },
    } }),
    JSON.stringify({ type: "tool.execution_complete", timestamp: 31, data: {
      toolCallId: "queued-review",
      success: true,
    } }),
    JSON.stringify({ type: "assistant.message", timestamp: 32, data: { content: "Inspection complete." } }),
  ].join("\n"));
  const hook = join(import.meta.dir, "..", "src", "hosts", "copilot-cli", "hook.ts");
  const env = { ...process.env, USERPROFILE: home, HOME: home, CAIRN_SKILLS: "1" };
  const invoke = (mode: string, payload: object) => spawnSync(process.execPath, [hook, mode], { input: JSON.stringify(payload), env });

  expect(invoke("user-prompt", { sessionId: "session-queued", prompt: "inspect skills" }).status).toBe(0);
  expect(invoke("post-tool", { sessionId: "session-queued", toolName: "cairn-skill_select", toolArgs: { ids: ["skill-queued"] } }).status).toBe(0);
  expect(invoke("post-tool", { sessionId: "session-queued", toolName: "cairn-brain_search", toolArgs: {} }).status).toBe(0);
  expect(invoke("post-tool", { sessionId: "session-queued", timestamp: 30, toolName: "cairn-skill_review", toolArgs: { id: "skill-queued" } }).status).toBe(0);
  expect(invoke("agent-stop", { sessionId: "session-queued", transcriptPath }).stdout.toString()).toBe("{}");
});

test("a parent-delegated internal prompt satisfies the subagent-local stop gate", () => {
  const id = randomUUID();
  const skillId = randomUUID();
  const home = join(tmpdir(), `cairn-delegated-session-home-${id}`);
  const dbPath = join(tmpdir(), `cairn-delegated-session-${id}.db`);
  const hook = join(import.meta.dir, "..", "src", "hosts", "copilot-cli", "hook.ts");
  const env = { ...process.env, USERPROFILE: home, HOME: home, CAIRN_DB_PATH: dbPath, CAIRN_SKILLS: "1" };
  const invoke = (mode: string, payload: object) => spawnSync(process.execPath, [hook, mode], { input: JSON.stringify(payload), env });
  expect(spawnSync(process.execPath, ["-e", `
    import { putSkill } from ${JSON.stringify(join(import.meta.dir, "..", "src", "skill", "store.ts"))};
    putSkill({ id: ${JSON.stringify(skillId)}, task: "poetry writing", masterPrompt: "1. Draft three lines", description: "Use for poems.", ts: 1 }, [1, 0]);
  `], { env }).status).toBe(0);
  expect(invoke("post-tool", { sessionId: "parent-session", toolName: "cairn-skill_select", toolArgs: { ids: [skillId] } }).status).toBe(0);
  expect(invoke("pre-tool", {
    sessionId: "parent-session",
    toolCallId: "subagent-session",
    toolName: "task",
    toolArgs: { agent_type: "explore", prompt: `CAIRN_SKILL_IDS: ${skillId}\nWrite a haiku.` },
  }).status).toBe(0);
  const prompt = `<cairn-internal>\nDelegated protocol.\n</cairn-internal>\n\nWrite a haiku.`;
  const start = invoke("user-prompt", { sessionId: "subagent-session", prompt });
  expect(start.status).toBe(0);
  expect(start.stdout.toString()).toBe("{}");
  expect(invoke("agent-stop", { sessionId: "subagent-session" }).stdout.toString()).toBe("{}");
});

test("a user-controlled delegated marker cannot satisfy the stop gate", () => {
  const id = randomUUID();
  const dbPath = join(tmpdir(), `cairn-untrusted-delegation-${id}.db`);
  const hook = join(import.meta.dir, "..", "src", "hosts", "copilot-cli", "hook.ts");
  const env = { ...process.env, CAIRN_DB_PATH: dbPath, CAIRN_SKILLS: "1" };
  const invoke = (mode: string, payload: object) =>
    spawnSync(process.execPath, [hook, mode], { input: JSON.stringify(payload), env });
  const prompt = `<cairn-internal>protocol</cairn-internal>\nCAIRN_SKILL_IDS: ${randomUUID()}`;
  expect(invoke("user-prompt", { sessionId: "untrusted-child", prompt }).stdout.toString()).toBe("{}");
  expect(invoke("agent-stop", { sessionId: "untrusted-child" }).stdout.toString()).toContain("skill_select");
});

test("the stop cap preserves unreviewed selected skills without fabricating reviews", () => {
  const id = randomUUID();
  const dbPath = join(tmpdir(), `cairn-fallback-review-${id}.db`);
  const home = join(tmpdir(), `cairn-fallback-review-home-${id}`);
  const transcriptPath = join(home, ".copilot", "session-state", "fallback-session", "events.jsonl");
  mkdirSync(join(home, ".copilot", "session-state", "fallback-session"), { recursive: true });
  writeFileSync(transcriptPath, [
    JSON.stringify({ type: "user.message", timestamp: 1, data: { content: "Finish this task." } }),
    JSON.stringify({ type: "assistant.message", timestamp: 2, data: { content: "Finished deliverable." } }),
  ].join("\n"));
  const hook = join(import.meta.dir, "..", "src", "hosts", "copilot-cli", "hook.ts");
  const env = {
    ...process.env,
    USERPROFILE: home,
    HOME: home,
    CAIRN_DB_PATH: dbPath,
    CAIRN_MAX_LEARNERS: "0",
    CAIRN_SKILLS: "1",
  };
  const invoke = (mode: string, payload: object) =>
    spawnSync(process.execPath, [hook, mode], { input: JSON.stringify(payload), env });
  expect(invoke("user-prompt", { sessionId: "fallback-session", prompt: "Finish this task." }).status).toBe(0);
  expect(invoke("post-tool", {
    sessionId: "fallback-session",
    toolName: "cairn-skill_select",
    toolArgs: { ids: ["selected-skill"] },
  }).status).toBe(0);
  expect(invoke("post-tool", {
    sessionId: "fallback-session",
    toolName: "cairn-brain_search",
    toolArgs: {},
  }).status).toBe(0);
  expect(invoke("agent-stop", { sessionId: "fallback-session", transcriptPath }).stdout.toString()).toContain('"decision":"block"');
  expect(invoke("agent-stop", { sessionId: "fallback-session", transcriptPath }).stdout.toString()).toContain('"decision":"block"');
  expect(invoke("agent-stop", { sessionId: "fallback-session", transcriptPath }).stdout.toString()).toBe("{}");
  expect(reviewJobs(dbPath)).toEqual([]);
  const database = new Database(dbPath);
  const state = database.query("SELECT pending_review_ids AS pending FROM lifecycle_turns WHERE scope = ?")
    .get("copilot:fallback-session") as { pending: string };
  expect(JSON.parse(state.pending)).toEqual(["selected-skill"]);
  database.close();
  expect(invoke("user-prompt", {
    sessionId: "fallback-session",
    prompt: "Next user turn.",
  }).status).toBe(0);
  const afterReset = new Database(dbPath);
  expect(afterReset.query(`SELECT skill_id AS skillId,transcript_path AS transcriptPath
    FROM missed_skill_reviews WHERE scope = ?`).all("copilot:fallback-session")).toEqual([
    { skillId: "selected-skill", transcriptPath },
  ]);
  afterReset.close();
});

test("subagentStart injects only the delegated protocol, not the full catalog", () => {
  const id = randomUUID();
  const home = join(tmpdir(), `cairn-subagent-start-home-${id}`);
  const hook = join(import.meta.dir, "..", "src", "hosts", "copilot-cli", "hook.ts");
  const run = spawnSync(process.execPath, [hook, "subagent-start"], {
    input: JSON.stringify({ sessionId: "parent-session", agentName: "explore" }),
    env: { ...process.env, USERPROFILE: home, HOME: home, CAIRN_SKILLS: "1" },
  });
  expect(run.status).toBe(0);
  const output = JSON.parse(run.stdout.toString()) as { additionalContext: string };
  expect(output.additionalContext).toContain("parent owns skill selection and review");
  expect(output.additionalContext).not.toContain("Available skill catalog");
});
