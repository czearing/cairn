import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  gateDecision,
  harnessTurnDeferred,
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
  expect(stopDecision({ brainUsed: false, skillUsed: false, stopNudges: 0 })).toEqual({ file: "skill-search-reminder.md" });
});

test("stopDecision allows a completed skill and brain workflow to finish", () => {
  expect(stopDecision({ brainUsed: true, skillUsed: true, stopNudges: 0 })).toEqual({ file: "" });
});

test("stopDecision requires skill selection even when the brain was used", () => {
  expect(stopDecision({ brainUsed: true, skillUsed: false, stopNudges: 0 })).toEqual({ file: "skill-search-reminder.md" });
});

test("stopDecision stops nudging once the per-turn cap is reached (no infinite loop)", () => {
  expect(stopDecision({ brainUsed: false, skillUsed: true, stopNudges: STOP_CAP })).toEqual({ file: "" });
});

test("Harness defers turn completion only while its durable task is waiting", () => {
  const id = randomUUID();
  const path = join(tmpdir(), `cairn-harness-review-state-${id}.db`);
  const database = new Database(path);
  database.run("CREATE TABLE agents(agent_id TEXT PRIMARY KEY,status TEXT NOT NULL)");
  database.run(`CREATE TABLE tasks(
    id TEXT PRIMARY KEY,assignee TEXT NOT NULL,status TEXT NOT NULL,
    created_at TEXT NOT NULL,claimed_at TEXT,completed_at TEXT
  )`);
  database.query("INSERT INTO agents(agent_id,status) VALUES (?,?)").run("developer", "working");
  database.query("INSERT INTO tasks(id,assignee,status,created_at,claimed_at) VALUES (?,?,?,?,?)")
    .run("task-1", "developer", "claimed", "2026-07-17T10:00:00Z", "2026-07-17T10:01:00Z");
  database.query("INSERT INTO tasks(id,assignee,status,created_at) VALUES (?,?,?,?)")
    .run("newer-buffered", "developer", "buffered", "2026-07-17T11:00:00Z");
  database.close();
  expect(harnessTurnDeferred(path, "developer")).toBe(false);

  const waiting = new Database(path);
  waiting.query("UPDATE tasks SET status='waiting',claimed_at=NULL WHERE id=?").run("task-1");
  waiting.close();
  expect(harnessTurnDeferred(path, "developer")).toBe(true);

  const completed = new Database(path);
  completed.query("UPDATE agents SET status='idle' WHERE agent_id=?").run("developer");
  completed.query("UPDATE tasks SET status='completed',completed_at=? WHERE id=?")
    .run("2026-07-17T10:02:00Z", "task-1");
  completed.close();
  expect(harnessTurnDeferred(path, "developer")).toBe(false);

  const overlapping = new Database(path);
  overlapping.query("INSERT INTO tasks(id,assignee,status,created_at) VALUES (?,?,?,?)")
    .run("older-waiting", "developer", "waiting", "2026-07-17T09:00:00Z");
  overlapping.query("INSERT INTO tasks(id,assignee,status,created_at) VALUES (?,?,?,?)")
    .run("newest-pending", "developer", "pending", "2026-07-17T12:00:00Z");
  overlapping.close();
  expect(harnessTurnDeferred(path, "developer")).toBe(false);
  rmSync(path, { force: true });
});

test("Harness completes without queueing a review after a durable wait resolves", () => {
  const id = randomUUID();
  const cairnDb = join(tmpdir(), `cairn-harness-review-${id}.db`);
  const harnessDb = join(tmpdir(), `cairn-harness-task-${id}.db`);
  const transcriptPath = join(tmpdir(), `cairn-harness-review-${id}.jsonl`);
  const harness = new Database(harnessDb);
  harness.run("CREATE TABLE agents(agent_id TEXT PRIMARY KEY,status TEXT NOT NULL)");
  harness.run(`CREATE TABLE tasks(
    id TEXT PRIMARY KEY,assignee TEXT NOT NULL,status TEXT NOT NULL,
    created_at TEXT NOT NULL,claimed_at TEXT,completed_at TEXT
  )`);
  harness.query("INSERT INTO agents(agent_id,status) VALUES (?,?)").run("developer", "working");
  harness.query("INSERT INTO tasks(id,assignee,status,created_at,claimed_at) VALUES (?,?,?,?,?)")
    .run("task-1", "developer", "waiting", "2026-07-17T10:00:00Z", "2026-07-17T10:01:00Z");
  harness.close();
  writeFileSync(transcriptPath, [
    JSON.stringify({ type: "user.message", timestamp: 1, data: { content: "Implement the feature." } }),
    JSON.stringify({ type: "assistant.message", timestamp: 2, data: { content: "Progress update." } }),
  ].join("\n"));
  const hook = join(import.meta.dir, "..", "src", "hosts", "copilot-cli", "hook.ts");
  const env = {
    ...process.env,
    AGENT_HARNESS: "1",
    CAIRN_DB_PATH: cairnDb,
    CAIRN_HARNESS_DB: harnessDb,
    CAIRN_HARNESS_AGENT: "developer",
    CAIRN_MAX_LEARNERS: "0",
    CAIRN_SKILLS: "1",
  };
  const invoke = (mode: string, payload: object) =>
    spawnSync(process.execPath, [hook, mode], { input: JSON.stringify(payload), env });
  const select = () => invoke("post-tool", {
    sessionId: "harness-session",
    toolName: "cairn-skill_select",
    toolArgs: { ids: ["implementation-skill"] },
  });
  const searchBrain = () => invoke("post-tool", {
    sessionId: "harness-session",
    toolName: "cairn-brain_search",
    toolArgs: { query: "implementation guidance" },
  });

  expect(select().status).toBe(0);
  expect(searchBrain().status).toBe(0);
  expect(invoke("agent-stop", { sessionId: "harness-session", transcriptPath }).stdout.toString()).toBe("{}");
  expect(reviewJobs(cairnDb)).toEqual([]);

  expect(invoke("user-prompt", { sessionId: "harness-session", prompt: "Complete the retried task." }).status).toBe(0);
  expect(select().status).toBe(0);
  expect(searchBrain().status).toBe(0);
  const completed = new Database(harnessDb);
  completed.query("UPDATE tasks SET status='completed',completed_at=? WHERE id=?")
    .run("2026-07-17T10:02:00Z", "task-1");
  completed.close();
  writeFileSync(transcriptPath, [
    JSON.stringify({ type: "user.message", timestamp: 1, data: { content: "Complete the retried task." } }),
    JSON.stringify({ type: "assistant.message", timestamp: 2, data: { content: "The feature is complete." } }),
  ].join("\n"));

  expect(invoke("agent-stop", { sessionId: "harness-session", transcriptPath }).stdout.toString())
    .toContain("completed every requested task");
  expect(invoke("agent-stop", { sessionId: "harness-session", transcriptPath }).stdout.toString()).toBe("{}");
  expect(reviewJobs(cairnDb)).toEqual([]);
  rmSync(cairnDb, { force: true });
  rmSync(harnessDb, { force: true });
  rmSync(transcriptPath, { force: true });
}, 20_000);

test("Harness user prompts receive the complete user Cairn workflow", () => {
  const id = randomUUID();
  const cairnDb = join(tmpdir(), `cairn-harness-prompt-${id}.db`);
  const hook = join(import.meta.dir, "..", "src", "hosts", "copilot-cli", "hook.ts");
  const invoke = (sessionId: string, agentHarness?: string) =>
    spawnSync(process.execPath, [hook, "user-prompt"], {
      input: JSON.stringify({ sessionId, prompt: "Complete the task." }),
      env: {
        ...process.env,
        AGENT_HARNESS: agentHarness,
        CAIRN_DB_PATH: cairnDb,
        CAIRN_MAX_LEARNERS: "0",
        CAIRN_SKILLS: "1",
      },
    });
  const direct = invoke("direct-prompt-parity");
  const harness = invoke("harness-prompt-parity", "1");

  expect(direct.status).toBe(0);
  expect(harness.status).toBe(0);
  const directOutput = JSON.parse(direct.stdout.toString()) as { additionalContext: string };
  const harnessOutput = JSON.parse(harness.stdout.toString()) as { additionalContext: string };
  expect(harnessOutput.additionalContext).toBe(directOutput.additionalContext);
  expect(harnessOutput.additionalContext).toContain("## Read the Shared Brain First");
  expect(harnessOutput.additionalContext).toContain("## Decompose Into Nodes");
  expect(harnessOutput.additionalContext).toContain("Topical similarity is not a fit");
  rmSync(cairnDb, { force: true });
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

test("a host-native skill invocation satisfies the skill gate without creating a review obligation", () => {
  const id = randomUUID();
  const dbPath = join(tmpdir(), `cairn-native-skill-${id}.db`);
  const hook = join(import.meta.dir, "..", "src", "hosts", "copilot-cli", "hook.ts");
  const env = { ...process.env, CAIRN_DB_PATH: dbPath, CAIRN_SKILLS: "1" };
  const invoke = (mode: string, payload: object) =>
    spawnSync(process.execPath, [hook, mode], { input: JSON.stringify(payload), env });

  expect(invoke("user-prompt", { sessionId: "native-skill", prompt: "Check Harness reliability." }).status).toBe(0);
  expect(invoke("post-tool", {
    sessionId: "native-skill",
    toolName: "skill",
    toolArgs: { skill: "cairn-harness" },
    toolResult: { ok: true },
  }).status).toBe(0);
  expect(invoke("post-tool", {
    sessionId: "native-skill",
    toolName: "cairn-brain_search",
    toolArgs: { query: "Harness reliability" },
  }).status).toBe(0);

  const stop = invoke("agent-stop", { sessionId: "native-skill" }).stdout.toString();
  expect(stop).toContain("completed every requested task");
  expect(stop).not.toContain("skill_select");
  expect(lifecycleState(dbPath, "copilot:native-skill").pendingReviewIds).toEqual([]);
});

test("a stale model tool manifest fails open until a Cairn tool is successfully observed", () => {
  const id = randomUUID();
  const dbPath = join(tmpdir(), `cairn-stale-manifest-${id}.db`);
  const hook = join(import.meta.dir, "..", "src", "hosts", "copilot-cli", "hook.ts");
  const env = {
    ...process.env,
    CAIRN_DB_PATH: dbPath,
    CAIRN_ENFORCE_STOP_GATES: "0",
    CAIRN_SKILLS: "1",
  };
  const invoke = (mode: string, payload: object) =>
    spawnSync(process.execPath, [hook, mode], { input: JSON.stringify(payload), env });

  expect(invoke("user-prompt", { sessionId: "stale-manifest", prompt: "Finish the task." }).status).toBe(0);
  const ignored = invoke("agent-stop", { sessionId: "stale-manifest" }).stdout.toString();
  expect(ignored).toContain("attempt the injected Cairn brain and skill workflow");
  expect(invoke("post-tool", {
    sessionId: "stale-manifest",
    toolName: "cairn-brain_search",
    toolArgs: { query: "task" },
    toolResult: { success: false, isError: true },
  }).status).toBe(0);
  const unavailable = invoke("agent-stop", { sessionId: "stale-manifest" }).stdout.toString();
  expect(unavailable).toContain("completed every requested task");
  expect(unavailable).not.toContain("attempt the injected Cairn");

  expect(invoke("user-prompt", { sessionId: "stale-manifest", prompt: "Try again." }).status).toBe(0);
  expect(invoke("post-tool", {
    sessionId: "stale-manifest",
    toolName: "cairn-brain_search",
    toolArgs: { query: "task" },
    toolResult: { success: true },
  }).status).toBe(0);
  expect(invoke("agent-stop", { sessionId: "stale-manifest" }).stdout.toString()).toContain("skill_select");
});

test("an ignored healthy Cairn workflow gets one retry before failing open", () => {
  const id = randomUUID();
  const dbPath = join(tmpdir(), `cairn-ignored-workflow-${id}.db`);
  const hook = join(import.meta.dir, "..", "src", "hosts", "copilot-cli", "hook.ts");
  const env = {
    ...process.env,
    CAIRN_DB_PATH: dbPath,
    CAIRN_ENFORCE_STOP_GATES: "0",
    CAIRN_SKILLS: "1",
  };
  const invoke = (mode: string, payload: object) =>
    spawnSync(process.execPath, [hook, mode], { input: JSON.stringify(payload), env });

  expect(invoke("user-prompt", { sessionId: "ignored-workflow", prompt: "Finish the task." }).status).toBe(0);
  expect(invoke("agent-stop", { sessionId: "ignored-workflow" }).stdout.toString())
    .toContain("attempt the injected Cairn brain and skill workflow");
  expect(invoke("agent-stop", { sessionId: "ignored-workflow" }).stdout.toString())
    .toContain("completed every requested task");
  expect(invoke("agent-stop", { sessionId: "ignored-workflow" }).stdout.toString()).toBe("{}");
  rmSync(dbPath, { force: true });
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

test("subagentStop clears its lifecycle without queueing skill reviews", () => {
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
  expect(reviewJobs(dbPath)).toEqual([]);
  const parentState = lifecycleState(dbPath, "copilot:session-1");
  expect(parentState.pendingReviewIds).toEqual(["parent-skill"]);
  expect(invoke("agent-stop", { sessionId: "session-1" }).stdout.toString()).toContain('"decision":"block"');
});

test("subagentStop never queues a reviewer for same-name agents", () => {
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
  expect(reviewJobs(dbPath)).toEqual([]);
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

test("skill_select preserves selected ids for delegation and ignores removed review calls", () => {
  const id = randomUUID();
  const home = join(tmpdir(), `cairn-multi-skill-home-${id}`);
  const dbPath = join(tmpdir(), `cairn-multi-skill-${id}.db`);
  const hook = join(import.meta.dir, "..", "src", "hosts", "copilot-cli", "hook.ts");
  const env = { ...process.env, USERPROFILE: home, HOME: home, CAIRN_DB_PATH: dbPath, CAIRN_SKILLS: "1" };
  const invoke = (payload: object) => spawnSync(process.execPath, [hook, "post-tool"], { input: JSON.stringify(payload), env });

  expect(invoke({ sessionId: "session-multi", toolName: "cairn-skill_select", toolArgs: { ids: ["skill-a", "skill-b"] } }).status).toBe(0);
  expect(lifecycleState(dbPath, "copilot:session-multi").pendingReviewIds).toEqual(["skill-a", "skill-b"]);
  expect(invoke({ sessionId: "session-multi", timestamp: 20, toolName: "cairn-skill_review", toolArgs: { id: "skill-a" } }).status).toBe(0);
  expect(lifecycleState(dbPath, "copilot:session-multi").pendingReviewIds).toEqual(["skill-a", "skill-b"]);
  expect(invoke({ sessionId: "session-multi", timestamp: 21, toolName: "cairn-skill_review", toolArgs: { id: "skill-b" } }).status).toBe(0);
  const state = lifecycleState(dbPath, "copilot:session-multi");
  expect(state.pendingReviewIds).toEqual(["skill-a", "skill-b"]);
  expect(state.pendingReviews).toHaveLength(0);
});

test("legacy search without an exact loaded skill creates no review obligation", () => {
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
  const reminder = invoke("agent-stop", { sessionId: "legacy-reminder" }).stdout.toString();
  expect(reminder).toContain("skill_select");
  expect(reminder).not.toContain("__legacy__");
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

test.skip("removed skill_review declarations are not lifecycle events", () => {
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
  expect(stop.stdout.toString()).toContain("completed every requested task");
  expect(reviewJobs(dbPath)).toEqual([]);
  expect(invoke("agent-stop", { sessionId: "session-2" }).stdout.toString()).toBe("{}");
  expect(reviewJobs(dbPath)).toEqual([{ skill_id: "skill-2", status: "pending" }]);
});

test.skip("removed skill_review declarations do not gate deliverables", () => {
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
    .toContain("completed every requested task");
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

test.skip("removed automatic learning does not run after stop gates", () => {
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
  expect(invoke("agent-stop", { sessionId: "session-3", transcriptPath }).stdout.toString())
    .toContain("completed every requested task");
  expect(invoke("agent-stop", { sessionId: "session-3", transcriptPath }).stdout.toString()).toBe("{}");
  expect(reviewJobs(dbPath)).toEqual([{ skill_id: "skill-3", status: "pending" }]);
});

test.skip("removed review enqueue cannot block stop", () => {
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
  expect(invoke("agent-stop").stdout.toString()).toContain("completed every requested task");
  expect(invoke("agent-stop").stdout.toString()).toBe("{}");

  expect(invoke("user-prompt", { sessionId: "session-cap", prompt: "second" }).status).toBe(0);
  expect(invoke("agent-stop").stdout.toString()).toContain('"decision":"block"');
});

test("a genuine Harness resume cannot inherit an exhausted stop cap without its workflow state", () => {
  const id = randomUUID();
  const home = join(tmpdir(), `cairn-harness-resume-home-${id}`);
  const hook = join(import.meta.dir, "..", "src", "hosts", "copilot-cli", "hook.ts");
  const env = { ...process.env, USERPROFILE: home, HOME: home, AGENT_HARNESS: "1", CAIRN_SKILLS: "0" };
  const invoke = (mode: string, payload: object = { sessionId: "harness-resume" }) =>
    spawnSync(process.execPath, [hook, mode], { input: JSON.stringify(payload), env });

  expect(invoke("user-prompt", { sessionId: "harness-resume", prompt: "root work" }).status).toBe(0);
  expect(invoke("agent-stop").stdout.toString()).toContain("skill_select");
  expect(invoke("post-tool", {
    sessionId: "harness-resume",
    toolName: "cairn-skill_select",
    toolArgs: { ids: ["remediation"] },
  }).status).toBe(0);
  expect(invoke("agent-stop").stdout.toString()).toContain("brain_search");

  expect(invoke("user-prompt", {
    sessionId: "harness-resume",
    prompt: "Role: Editor. Resume the root after delegated work completed.",
  }).status).toBe(0);
  expect(invoke("agent-stop").stdout.toString()).toContain("skill_select");
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
  expect(invoke("agent-stop", { sessionId: "session-queued", transcriptPath }).stdout.toString())
    .toContain("completed every requested task");
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
  expect(invoke("agent-stop", { sessionId: "subagent-session" }).stdout.toString())
    .toContain("completed every requested task");
  expect(invoke("agent-stop", { sessionId: "subagent-session" }).stdout.toString()).toBe("{}");
});

test("a transcriptless tool-call subagent leaves skill maintenance to its parent", () => {
  const id = randomUUID();
  const dbPath = join(tmpdir(), `cairn-tool-call-subagent-${id}.db`);
  const hook = join(import.meta.dir, "..", "src", "hosts", "copilot-cli", "hook.ts");
  const env = { ...process.env, CAIRN_DB_PATH: dbPath, CAIRN_SKILLS: "1" };
  const invoke = (mode: string, payload: object) =>
    spawnSync(process.execPath, [hook, mode], { input: JSON.stringify(payload), env });
  const sessionId = `call_${id}`;

  const start = invoke("user-prompt", { sessionId, prompt: "Review this diff." });
  expect(start.stdout.toString()).toContain("parent owns skill selection and maintenance");
  expect(start.stdout.toString()).not.toContain("Available skill catalog");
  expect(invoke("post-tool", {
    sessionId,
    toolName: "cairn-skill_select",
    toolArgs: { ids: ["skill-review", "skill-test"] },
  }).status).toBe(0);
  expect(invoke("agent-stop", { sessionId, transcriptPath: "" }).stdout.toString()).toBe("{}");

  const database = new Database(dbPath);
  const missedTable = database.query("SELECT 1 present FROM sqlite_master WHERE type='table' AND name='missed_skill_reviews'").get();
  expect(missedTable ? database.query("SELECT COUNT(*) count FROM missed_skill_reviews").get() : { count: 0 }).toEqual({ count: 0 });
  const state = database.query("SELECT pending_review_ids pendingIds, pending_reviews pending FROM lifecycle_turns WHERE scope=?")
    .get(`copilot:${sessionId}`) as { pendingIds: string; pending: string };
  expect(JSON.parse(state.pendingIds)).toEqual([]);
  expect(JSON.parse(state.pending)).toEqual([]);
  database.close();
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

test("agentStop clears selected skill state after the visible deliverable", () => {
  const id = randomUUID();
  const dbPath = join(tmpdir(), `cairn-fallback-review-${id}.db`);
  const home = join(tmpdir(), `cairn-fallback-review-home-${id}`);
  const transcriptPath = join(home, ".copilot", "session-state", "fallback-session", "events.jsonl");
  mkdirSync(join(home, ".copilot", "session-state", "fallback-session"), { recursive: true });
  writeFileSync(transcriptPath, [
    JSON.stringify({ type: "user.message", timestamp: 1, data: { content: "Finish this task." } }),
    JSON.stringify({ type: "assistant.message", timestamp: 2, data: { content: "Finished deliverable." } }),
    JSON.stringify({ type: "user.message", timestamp: 3, data: { content: "Injected unrelated task." } }),
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
  const completion = invoke("agent-stop", { sessionId: "fallback-session", transcriptPath }).stdout.toString();
  expect(completion).toContain('"decision":"block"');
  expect(completion).toContain("completed every requested task");
  expect(reviewJobs(dbPath)).toEqual([]);
  expect(invoke("agent-stop", { sessionId: "fallback-session", transcriptPath }).stdout.toString()).toBe("{}");
  expect(reviewJobs(dbPath)).toEqual([]);
  const database = new Database(dbPath);
  const state = database.query("SELECT pending_review_ids AS pending FROM lifecycle_turns WHERE scope = ?")
    .get("copilot:fallback-session") as { pending: string };
  expect(JSON.parse(state.pending)).toEqual([]);
  database.close();
});

test("removed review enqueue never touches the legacy inflight path", () => {
  const id = randomUUID();
  const home = join(tmpdir(), `cairn-auto-review-failure-home-${id}`);
  const dbPath = join(tmpdir(), `cairn-auto-review-failure-${id}.db`);
  const blockedInflight = join(tmpdir(), `cairn-auto-review-inflight-${id}`);
  const transcriptPath = join(home, ".copilot", "session-state", "auto-failure", "events.jsonl");
  mkdirSync(join(home, ".copilot", "session-state", "auto-failure"), { recursive: true });
  writeFileSync(blockedInflight, "not a directory");
  writeFileSync(transcriptPath, [
    JSON.stringify({ type: "user.message", id: "user-1", timestamp: 10, data: { content: "Fix the bug." } }),
    JSON.stringify({ type: "assistant.message", timestamp: 30, data: { content: "The bug is fixed." } }),
  ].join("\n"));
  const hook = join(import.meta.dir, "..", "src", "hosts", "copilot-cli", "hook.ts");
  const env = {
    ...process.env,
    USERPROFILE: home,
    HOME: home,
    CAIRN_DB_PATH: dbPath,
    CAIRN_INFLIGHT_DIR: blockedInflight,
    CAIRN_MAX_LEARNERS: "0",
    CAIRN_SKILLS: "1",
  };
  const invoke = (mode: string, payload: object) =>
    spawnSync(process.execPath, [hook, mode], { input: JSON.stringify(payload), env });

  expect(invoke("post-tool", {
    sessionId: "auto-failure",
    toolName: "cairn-skill_select",
    toolArgs: { ids: ["skill-auto-failure"] },
  }).status).toBe(0);
  expect(invoke("post-tool", {
    sessionId: "auto-failure",
    toolName: "cairn-brain_search",
    toolArgs: {},
  }).status).toBe(0);
  expect(invoke("agent-stop", { sessionId: "auto-failure", transcriptPath }).stdout.toString())
    .toContain("completed every requested task");
  expect(invoke("agent-stop", { sessionId: "auto-failure", transcriptPath }).stdout.toString()).toBe("{}");
  expect(reviewJobs(dbPath)).toEqual([]);
  rmSync(blockedInflight, { force: true });
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
  expect(output.additionalContext).toContain("parent owns skill selection and maintenance");
  expect(output.additionalContext).not.toContain("Available skill catalog");
});
