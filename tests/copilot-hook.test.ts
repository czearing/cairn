import { afterAll, beforeAll, test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import {
  extractResultNodeId,
  gateDecision,
  harnessTurnDeferred,
  internalContext,
  isTool,
  postToolFiles,
  resolveCopilotModel,
  STOP_CAP,
  shouldStartUserTurn,
  stopDecision,
  requiredBrainNodes,
  countsAsExecution,
  changesDurableState,
  scratchOnlyShellCommand,
  reportedNonZeroExit,
  workflowActionDecision,
} from "../src/hosts/copilot-cli/hook";

const priorCompletionContinuation = process.env.CAIRN_FORCE_COMPLETION_CONTINUATION;
beforeAll(() => {
  process.env.CAIRN_FORCE_COMPLETION_CONTINUATION = "1";
  process.env.CAIRN_REVIEWER_MOCK = "approve";
});
afterAll(() => {
  if (priorCompletionContinuation == null) delete process.env.CAIRN_FORCE_COMPLETION_CONTINUATION;
  else process.env.CAIRN_FORCE_COMPLETION_CONTINUATION = priorCompletionContinuation;
  delete process.env.CAIRN_REVIEWER_MOCK;
});

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

// The contract gate is unconditional, so any test that expects a turn to be RELEASED must first put a
// satisfied contract where the `contract` MCP tool writes it: beside the database.
function sessionContractPath(dir: string, sessionId: string): string {
  return join(dir, "contracts", `${createHash("sha256").update(sessionId).digest("hex")}.json`);
}

function satisfyContract(dbPath: string, sessionId: string, check = "the task is done"): void {
  const path = sessionContractPath(dirname(dbPath), sessionId);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({
    criteria: [{ check, passed: true, failedFirst: false, evidence: "verified" }], nudges: 0,
  }));
}

function telemetryKinds(dbPath: string): string[] {
  const database = new Database(dbPath);
  try {
    return database.query("SELECT kind FROM telemetry_events ORDER BY ts")
      .all().map((row) => String((row as { kind: string }).kind));
  } finally {
    database.close();
  }
}

function completeBrainWorkflow(
  invoke: (mode: string, payload: object) => ReturnType<typeof spawnSync>,
  sessionId: string,
  options: { contractDir?: string; declareContract?: boolean } = {},
): void {
  // The contract gate is unconditional, so reaching a releasable state means the brain workflow AND a
  // satisfied contract. Written as a file because the criteria live beside the database, exactly where
  // the `contract` MCP tool writes them.
  if (options.declareContract !== false) {
    const path = sessionContractPath(options.contractDir ?? tmpdir(), sessionId);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({
      criteria: [{ check: `${sessionId} is done`, passed: true, failedFirst: false, evidence: "verified" }],
      nudges: 0,
    }));
  }
  const root = `${sessionId}-root`;
  const child = `${sessionId}-child`;
  const leaf = `${sessionId}-leaf`;
  expect(invoke("post-tool", {
    sessionId,
    toolName: "cairn-brain_search",
    toolArgs: { query: sessionId },
    toolResult: { success: true },
  }).status).toBe(0);
  for (const [id, edges] of [
    [root, []],
    [child, [root]],
    [leaf, [child]],
  ] as const) {
    expect(invoke("post-tool", {
      sessionId,
      toolName: "cairn-brain_create",
      toolArgs: { text: `How is ${id} resolved?`, edges },
      toolResult: { success: true, id },
    }).status).toBe(0);
  }
  for (const id of [leaf, child, root]) {
    expect(invoke("post-tool", {
      sessionId,
      toolName: "cairn-brain_mutate",
      toolArgs: { id, answer: `Resolved ${id}.`, citation: "https://example.com/evidence" },
      toolResult: { success: true, id },
    }).status).toBe(0);
  }
}

test("Copilot model attribution prefers payload, Harness environment, then profile settings", () => {
  const home = join(tmpdir(), `cairn-copilot-home-${randomUUID()}`);
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "settings.json"), JSON.stringify({ model: "settings-model" }));
  const environment: NodeJS.ProcessEnv = { COPILOT_HOME: home, CAIRN_MODEL: "harness-model" };
  try {
    expect(resolveCopilotModel("payload-model", environment)).toBe("payload-model");
    expect(resolveCopilotModel("", environment)).toBe("harness-model");
    delete environment.CAIRN_MODEL;
    expect(resolveCopilotModel("", environment)).toBe("settings-model");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// ── postToolFiles: which prompts a COMPLETED Copilot tool delivers, mirroring Claude's after-tool set ──

test("read-only tools do not count as execution", () => {
  expect(countsAsExecution("view", { path: "foo.ts" })).toBe(false);
  expect(countsAsExecution("grep", { pattern: "bar" })).toBe(false);
  expect(countsAsExecution("glob", { pattern: "*.ts" })).toBe(false);
  expect(countsAsExecution("sql", { query: "SELECT 1;" })).toBe(false);
  expect(countsAsExecution("session_store_sql", { query: "SELECT 1;" })).toBe(false);
  expect(countsAsExecution("ask_user", { question: "What is next?" })).toBe(false);
  expect(countsAsExecution("vote_memory", { fact: "foo" })).toBe(false);
  expect(countsAsExecution("store_memory", { fact: "foo" })).toBe(false);
  expect(countsAsExecution("edit", { path: "foo.ts" })).toBe(true);
  expect(countsAsExecution("create", { path: "foo.ts" })).toBe(true);
});

test("postToolFiles returns the search reminder for a brain_search", () => {
  expect(postToolFiles("cairn-brain_search", "")).toEqual(["search-results.md"]);
});

test("postToolFiles emits only state-specific graph reminders", () => {
  expect(postToolFiles("cairn-brain_create", "")).toEqual(["node-created.md"]);
  expect(postToolFiles("cairn-brain_mutate", "an answer")).toEqual([]);
  expect(postToolFiles("cairn-brain_mutate", "")).toEqual([]);
});

test("postToolFiles is empty for unrelated tools", () => {
  expect(postToolFiles("task", "")).toEqual([]);
  expect(postToolFiles("view", "")).toEqual([]);
  expect(postToolFiles("bash", "")).toEqual([]);
});

// ── stopDecision: the fail-closed agentStop workflow gate ─────────────────────────────────────────

test("stopDecision requires brain use", () => {
  expect(stopDecision({ brainUsed: false, stopNudges: 0 })).toEqual({ file: "turn-reminder.md" });
});

test("stopDecision allows a completed brain workflow to finish", () => {
  expect(stopDecision({ brainUsed: true, stopNudges: 0 })).toEqual({ file: "" });
});

test("strict stopDecision requires ordered decomposition and root synthesis", () => {
  expect(stopDecision({
    brainUsed: true,
    brainSearched: true,
    brainCreatedCount: 3,
    brainAnsweredCount: 2,
    rootSynthesized: true,
    stopNudges: 0,
    strict: true,
    minimumBrainNodes: 3,
  })).toEqual({ file: "turn-reminder.md" });
  expect(stopDecision({
    brainUsed: true,
    brainSearched: true,
    brainCreatedCount: 3,
    brainAnsweredCount: 3,
    rootSynthesized: true,
    stopNudges: 0,
    strict: true,
    minimumBrainNodes: 3,
  })).toEqual({ file: "" });
});

test("reusing prior work completes the turn instead of forcing duplicate nodes", () => {
  const reuse = {
    brainUsed: true,
    brainSearched: true,
    brainCreatedCount: 0,
    brainAnsweredCount: 0,
    stopNudges: 0,
    strict: true,
    minimumBrainNodes: 3,
  };
  // A search that found nothing recorded yet must name that state, NOT claim the turn recorded
  // nothing at all — the false claim is what pushed agents into re-creating existing work.
  expect(stopDecision(reuse)).toEqual({ file: "brain-reuse-reminder.md" });
  // Adopting one existing node discharges the obligation: the graph already holds the decomposition,
  // so demanding three fresh nodes would only duplicate it.
  expect(stopDecision({ ...reuse, brainReusedCount: 1 })).toEqual({ file: "" });
  // Never searching is a different failure and keeps the original instruction.
  expect(stopDecision({ ...reuse, brainSearched: false, brainReusedCount: 1 }))
    .toEqual({ file: "turn-reminder.md" });
});

test("reused nodes count toward the decomposition minimum for a partially covered task", () => {
  const partial = {
    brainUsed: true,
    brainSearched: true,
    brainCreatedCount: 1,
    brainAnsweredCount: 1,
    rootSynthesized: true,
    stopNudges: 0,
    strict: true,
    minimumBrainNodes: 3,
  };
  expect(stopDecision(partial)).toEqual({ file: "turn-reminder.md" });
  expect(stopDecision({ ...partial, brainReusedCount: 2 })).toEqual({ file: "" });
  // Creating nodes still requires answering all of them and synthesizing the root last.
  expect(stopDecision({ ...partial, brainReusedCount: 2, brainAnsweredCount: 0 }))
    .toEqual({ file: "turn-reminder.md" });
  expect(stopDecision({ ...partial, brainReusedCount: 2, rootSynthesized: false }))
    .toEqual({ file: "turn-reminder.md" });
});

test("Harness side effects are denied until the strict workflow is complete", () => {  const incomplete = {
    brainUsed: true,
    brainSearched: true,
    brainCreatedCount: 3,
    brainAnsweredCount: 2,
    rootSynthesized: false,
    pendingReviewCount: 0,
    stopNudges: 0,
    strict: true,
    minimumBrainNodes: 3,
  };
  expect(workflowActionDecision("discord_send_message", incomplete).deny).toBe(true);
  expect(workflowActionDecision("cairn-harness-task_complete", incomplete).deny).toBe(true);
  expect(workflowActionDecision("powershell", incomplete, {
    command: "git fetch origin master; az repos pr show --id 42",
  }).deny).toBe(false);
  expect(workflowActionDecision("powershell", incomplete, {
    command: "az devops invoke --http-method POST --area git",
  }).deny).toBe(true);
  expect(workflowActionDecision("powershell", incomplete, {
    command: "Set-Content result.txt 'changed'",
  }).deny).toBe(true);
  expect(workflowActionDecision("view", incomplete).deny).toBe(false);
  expect(workflowActionDecision("cairn-brain_mutate", incomplete).deny).toBe(false);
  expect(workflowActionDecision("discord_send_message", {
    ...incomplete,
    brainAnsweredCount: 3,
    rootSynthesized: true,
  }).deny).toBe(false);
});

test("Harness preToolUse blocks premature side effects and allows them after root synthesis", () => {
  const id = randomUUID();
  const dbPath = join(tmpdir(), `cairn-strict-action-${id}.db`);
  const copilotHome = join(tmpdir(), `cairn-strict-action-home-${id}`);
  const hook = join(import.meta.dir, "..", "src", "hosts", "copilot-cli", "hook.ts");
  const env = {
    ...process.env,
    AGENT_HARNESS: "1",
    CAIRN_DB_PATH: dbPath,
    COPILOT_HOME: copilotHome,
    CAIRN_MAX_LEARNERS: "0",
    CAIRN_SKILLS: "1",
  };
  const invoke = (mode: string, payload: object) =>
    spawnSync(process.execPath, [hook, mode], { input: JSON.stringify(payload), env });
  const post = (toolName: string, toolArgs: object, toolResult: object = { success: true }) =>
    invoke("post-tool", { sessionId: "strict-action", toolName, toolArgs, toolResult });

  invoke("user-prompt", { sessionId: "strict-action", prompt: "Send a certification message." });
  satisfyContract(dbPath, "strict-action", "the certification message is sent");
  post("skill", { skill: "discord" });
  post("cairn-brain_search", { query: "certification" });
  for (const nodeId of ["root", "child-1", "child-2"]) {
    post("cairn-brain_create", { text: nodeId }, { id: nodeId });
  }
  post("cairn-brain_mutate", { id: "child-1", answer: "evidence one" });
  post("cairn-brain_mutate", { id: "child-2", answer: "evidence two" });

  const denied = invoke("pre-tool", {
    sessionId: "strict-action",
    toolCalls: [{ id: "send-1", name: "discord-discord_send_message", args: { content: "too early" } }],
  }).stdout.toString();
  expect(denied).toContain('"permissionDecision":"deny"');
  expect(denied).toContain("side effect was not executed");

  post("cairn-brain_mutate", { id: "root", answer: "integrated synthesis" });
  expect(invoke("pre-tool", {
    sessionId: "strict-action",
    toolCalls: [{ id: "send-2", name: "discord-discord_send_message", args: { content: "ready" } }],
  }).stdout.toString()).toBe("{}");
  expect(invoke("pre-tool", {
    sessionId: "strict-action",
    toolCalls: [{ id: "complete-1", name: "cairn-harness-task_complete", args: { summary: "done" } }],
  }).stdout.toString()).toBe("{}");
  expect(invoke("agent-stop", { sessionId: "strict-action" }).stdout.toString()).toContain("completed every requested task");
  expect(invoke("agent-stop", { sessionId: "strict-action" }).stdout.toString()).toBe("{}");
  expect(JSON.parse(readFileSync(
    join(copilotHome, "session-state", "strict-action", "cairn-compliance.json"),
    "utf8",
  )).rootNodeId).toBe("root");
  rmSync(dbPath, { force: true });
  rmSync(copilotHome, { recursive: true, force: true });
}, 10_000);

test("with the skill layer off a Harness turn still unblocks side effects and certifies on brain work alone", () => {
  const id = randomUUID();
  const dbPath = join(tmpdir(), `cairn-skills-off-action-${id}.db`);
  const copilotHome = join(tmpdir(), `cairn-skills-off-action-home-${id}`);
  const hook = join(import.meta.dir, "..", "src", "hosts", "copilot-cli", "hook.ts");
  const env = {
    ...process.env,
    AGENT_HARNESS: "1",
    CAIRN_DB_PATH: dbPath,
    COPILOT_HOME: copilotHome,
    CAIRN_MAX_LEARNERS: "0",
    CAIRN_SKILLS: "0",
  };
  const invoke = (mode: string, payload: object) =>
    spawnSync(process.execPath, [hook, mode], { input: JSON.stringify(payload), env });
  const post = (toolName: string, toolArgs: object, toolResult: object = { success: true }) =>
    invoke("post-tool", { sessionId: "skills-off-action", toolName, toolArgs, toolResult });

  invoke("user-prompt", { sessionId: "skills-off-action", prompt: "Send a certification message." });
  satisfyContract(dbPath, "skills-off-action", "the certification message is sent");
  // No skill call anywhere in this turn: with the layer off there is no skill tool to call.
  post("cairn-brain_search", { query: "certification" });
  for (const nodeId of ["root", "child-1", "child-2"]) {
    post("cairn-brain_create", { text: nodeId }, { id: nodeId });
  }
  post("cairn-brain_mutate", { id: "child-1", answer: "evidence one" });
  post("cairn-brain_mutate", { id: "child-2", answer: "evidence two" });

  // The brain gate is untouched: acting before the root is synthesized is still denied.
  expect(invoke("pre-tool", {
    sessionId: "skills-off-action",
    toolCalls: [{ id: "send-1", name: "discord-discord_send_message", args: { content: "too early" } }],
  }).stdout.toString()).toContain('"permissionDecision":"deny"');

  post("cairn-brain_mutate", { id: "root", answer: "integrated synthesis" });
  expect(invoke("pre-tool", {
    sessionId: "skills-off-action",
    toolCalls: [{ id: "send-2", name: "discord-discord_send_message", args: { content: "ready" } }],
  }).stdout.toString()).toBe("{}");
  post("discord-discord_send_message", { content: "ready" });
  expect(invoke("agent-stop", { sessionId: "skills-off-action" }).stdout.toString())
    .toContain("completed every requested task");
  // The turn ENDS instead of looping forever demanding a skill, and it certifies for the Harness.
  expect(invoke("agent-stop", { sessionId: "skills-off-action" }).stdout.toString()).toBe("{}");
  expect(JSON.parse(readFileSync(
    join(copilotHome, "session-state", "skills-off-action", "cairn-compliance.json"),
    "utf8",
  )).rootNodeId).toBe("root");
  rmSync(dbPath, { force: true });
  rmSync(copilotHome, { recursive: true, force: true });
}, 10_000);

test("neither injected workflow carries skill instructions or a catalog", () => {
  const id = randomUUID();
  const home = join(tmpdir(), `cairn-skills-off-home-${id}`);
  const hook = join(import.meta.dir, "..", "src", "hosts", "copilot-cli", "hook.ts");
  const inject = (harness: boolean) => {
    const env = {
      ...process.env, USERPROFILE: home, HOME: home,
      AGENT_HARNESS: harness ? "1" : "",
    };
    const out = spawnSync(process.execPath, [hook, "user-prompt"], {
      input: JSON.stringify({ sessionId: `skills-${harness}-${id}`, prompt: "root work" }),
      env,
    });
    expect(out.status).toBe(0);
    return String(JSON.parse(out.stdout.toString()).additionalContext ?? "");
  };

  for (const harness of [false, true]) {
    const prompt = inject(harness);
    expect(prompt).toContain("earch");                       // the brain workflow still ships every turn
    expect(prompt).not.toContain("skill_select");
    expect(prompt).not.toContain("skill_create");
    expect(prompt).not.toContain("skill_edit");
    expect(prompt).not.toContain("Available skill catalog");
    expect(prompt).not.toContain("Skill application");
    expect(prompt).not.toContain("cairn:skills");            // the fence markers never reach the agent
  }
});

test("with the skill layer off the stop gate never demands a skill call", () => {
  const id = randomUUID();
  const home = join(tmpdir(), `cairn-skills-off-gate-home-${id}`);
  const hook = join(import.meta.dir, "..", "src", "hosts", "copilot-cli", "hook.ts");
  const env = { ...process.env, USERPROFILE: home, HOME: home, CAIRN_SKILLS: "0" };
  const invoke = (mode: string, payload: object = { sessionId: "skills-off-gate" }) =>
    spawnSync(process.execPath, [hook, mode], { input: JSON.stringify(payload), env });

  expect(invoke("user-prompt", { sessionId: "skills-off-gate", prompt: "root work" }).status).toBe(0);
  invoke("post-tool", { sessionId: "skills-off-gate", toolName: "edit", toolArgs: { path: "a.ts" }, toolResult: { success: true } });
  const blocked = invoke("agent-stop", { sessionId: "skills-off-gate" }).stdout.toString();
  // Still blocked on the brain workflow — disabling skills must not disable Cairn — but a turn can no
  // longer be held hostage by a skill tool that is not even registered.
  expect(blocked).toContain('"decision":"block"');
  expect(blocked).toContain("brain_search");
  expect(blocked).not.toContain("skill_select");
});

test("stopDecision never permits submission while the mandatory workflow is incomplete", () => {
  expect(stopDecision({
    brainUsed: false,
    brainSearched: false,
    brainCreatedCount: 0,
    brainAnsweredCount: 0,
    rootSynthesized: false,
    stopNudges: STOP_CAP,
    strict: true,
    minimumBrainNodes: 3,
  })).toEqual({ file: "turn-reminder.md" });
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
  const completeBrain = () => {
    for (const id of ["root", "child-1", "child-2"]) {
      invoke("post-tool", {
        sessionId: "harness-session",
        toolName: "cairn-brain_create",
        toolArgs: { text: id },
        toolResult: { id },
      });
    }
    for (const id of ["child-1", "child-2", "root"]) {
      invoke("post-tool", {
        sessionId: "harness-session",
        toolName: "cairn-brain_mutate",
        toolArgs: { id, answer: `${id} answer` },
      });
    }
  };

  expect(select().status).toBe(0);
  expect(searchBrain().status).toBe(0);
  completeBrain();
  satisfyContract(cairnDb, "harness-session", "the feature is implemented");
  expect(invoke("agent-stop", { sessionId: "harness-session", transcriptPath }).stdout.toString()).toBe("{}");

  expect(invoke("user-prompt", { sessionId: "harness-session", prompt: "Complete the retried task." }).status).toBe(0);
  expect(select().status).toBe(0);
  expect(searchBrain().status).toBe(0);
  completeBrain();
  satisfyContract(cairnDb, "harness-session", "the retried task is complete");
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
  rmSync(cairnDb, { force: true });
  rmSync(harnessDb, { force: true });
  rmSync(transcriptPath, { force: true });
}, 20_000);

test("Harness user prompts receive a leaner workflow than direct interactive prompts", () => {
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
  // Harness agents already carry a task-specific role prompt, so their injected Cairn workflow must be a
  // distinct, shorter prompt rather than the full explanatory text aimed at an unscoped interactive user.
  expect(harnessOutput.additionalContext).not.toBe(directOutput.additionalContext);
  expect(harnessOutput.additionalContext.length).toBeLessThan(directOutput.additionalContext.length);
  expect(directOutput.additionalContext).toContain("## Brain workflow");
  expect(directOutput.additionalContext.toLowerCase()).toContain("plan");
  for (const output of [directOutput.additionalContext, harnessOutput.additionalContext]) {
    expect(output.toLowerCase()).toContain("search");
    expect(output.toLowerCase()).toContain("create");
    expect(output.toLowerCase()).toContain("mutate");
  }
  rmSync(cairnDb, { force: true });
});

test("user-prompt sends detailed workflow on turn 1 and short reminder on subsequent turns", () => {
  const id = randomUUID();
  const dbPath = join(tmpdir(), `cairn-multi-turn-prompt-${id}.db`);
  const hook = join(import.meta.dir, "..", "src", "hosts", "copilot-cli", "hook.ts");
  const env = { ...process.env, CAIRN_DB_PATH: dbPath };
  const invoke = (prompt: string) =>
    spawnSync(process.execPath, [hook, "user-prompt"], {
      input: JSON.stringify({ sessionId: `multi-turn-${id}`, prompt }),
      env,
    });

  const turn1 = JSON.parse(invoke("First task.").stdout.toString()) as { additionalContext: string };
  expect(turn1.additionalContext).toContain("## Brain workflow");
  expect(turn1.additionalContext.toLowerCase()).toContain("plan");

  const turn2 = JSON.parse(invoke("Second task.").stdout.toString()) as { additionalContext: string };
  expect(turn2.additionalContext).toContain("Maintain Cairn discipline");
  expect(turn2.additionalContext).not.toContain("## Brain workflow");
  expect(turn2.additionalContext.length).toBeLessThan(turn1.additionalContext.length);
  rmSync(dbPath, { force: true });
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

test("a stale model tool manifest blocks submission until a Cairn tool succeeds", () => {
  const id = randomUUID();
  const dbPath = join(tmpdir(), `cairn-stale-manifest-${id}.db`);
  const hook = join(import.meta.dir, "..", "src", "hosts", "copilot-cli", "hook.ts");
  const env = {
    ...process.env,
    CAIRN_DB_PATH: dbPath,
    CAIRN_ENFORCE_STOP_GATES: "0",
  };
  const invoke = (mode: string, payload: object) =>
    spawnSync(process.execPath, [hook, mode], { input: JSON.stringify(payload), env });

  expect(invoke("user-prompt", { sessionId: "stale-manifest", prompt: "Finish the task." }).status).toBe(0);
  invoke("post-tool", { sessionId: "stale-manifest", toolName: "edit", toolArgs: { path: "a.ts" }, toolResult: { success: true } });
  const ignored = invoke("agent-stop", { sessionId: "stale-manifest" }).stdout.toString();
  expect(ignored).toContain("resolve this task in the brain");
  expect(ignored).not.toContain("run `/restart` once");
  expect(telemetryKinds(dbPath)).not.toContain("visibility_failure");
  expect(invoke("post-tool", {
    sessionId: "stale-manifest",
    toolName: "cairn-brain_search",
    toolArgs: { query: "task" },
    toolResult: { success: false, isError: true },
  }).status).toBe(0);
  const unavailable = invoke("agent-stop", { sessionId: "stale-manifest" }).stdout.toString();
  expect(unavailable).toContain("run `/restart` once");
  expect(unavailable).not.toContain("attempt the injected Cairn");
  expect(telemetryKinds(dbPath)).toContain("visibility_failure");
  expect(invoke("agent-stop", { sessionId: "stale-manifest" }).stdout.toString())
    .toContain("run `/restart` once");

  expect(invoke("user-prompt", { sessionId: "stale-manifest", prompt: "Try again." }).status).toBe(0);
  invoke("post-tool", { sessionId: "stale-manifest", toolName: "edit", toolArgs: { path: "a.ts" }, toolResult: { success: true } });
  expect(invoke("post-tool", {
    sessionId: "stale-manifest",
    toolName: "cairn-brain_search",
    toolArgs: { query: "task" },
    toolResult: { success: true },
  }).status).toBe(0);
  expect(invoke("agent-stop", { sessionId: "stale-manifest" }).stdout.toString()).toContain("brain_create");
});

// Ownership, not arithmetic: answering a node the turn did NOT create must never discharge the obligation
// to answer one it did. Verified against the real gate, which released with two created nodes still open.
test("answers to reused nodes cannot discharge the obligation to answer nodes the turn created", () => {
  const base = {
    brainUsed: true, brainSearched: true, rootSynthesized: true, skillUsed: true,
    stopNudges: 0, strict: true, minimumBrainNodes: 1,
  };
  // Created 3, answered 3 — but two of those answers were mutations of pre-existing nodes.
  expect(stopDecision({
    ...base, brainCreatedCount: 3, brainAnsweredCount: 3, brainReusedCount: 2, openCreatedCount: 2,
  }).file).toBe("turn-reminder.md");
  // The same turn once every created node is genuinely answered.
  expect(stopDecision({
    ...base, brainCreatedCount: 3, brainAnsweredCount: 3, brainReusedCount: 2, openCreatedCount: 0,
  }).file).toBe("");
  // Pure reuse turns are unaffected: nothing was created, so nothing is owed.
  expect(stopDecision({
    ...base, brainCreatedCount: 0, brainAnsweredCount: 1, brainReusedCount: 1, openCreatedCount: 0,
  }).file).toBe("");
});

// The gate's effect must be measurable, or there is no way to tell whether it is helping.
test("an ownership block is recorded as its own telemetry kind, with the number of open questions", () => {
  const id = randomUUID();
  const dbPath = join(tmpdir(), `cairn-ownership-telemetry-${id}.db`);
  const hook = join(import.meta.dir, "..", "src", "hosts", "copilot-cli", "hook.ts");
  const env = { ...process.env, CAIRN_DB_PATH: dbPath, CAIRN_ENFORCE_STOP_GATES: "1", CAIRN_SKILLS: "1" };
  const invoke = (mode: string, payload: object) =>
    spawnSync(process.execPath, [hook, mode], { input: JSON.stringify(payload), env });
  const session = "ownership-telemetry";

  expect(invoke("user-prompt", { sessionId: session, prompt: "Do the work." }).status).toBe(0);
  expect(invoke("post-tool", {
    sessionId: session, toolName: "cairn-skill_select", toolArgs: { ids: ["skill-own"] },
  }).status).toBe(0);
  expect(invoke("post-tool", {
    sessionId: session, toolName: "cairn-brain_search", toolArgs: { query: session }, toolResult: { success: true },
  }).status).toBe(0);
  // Two questions opened, only one closed: the turn still owes an answer to a question it asked.
  for (const nodeId of ["own-a", "own-b"]) {
    expect(invoke("post-tool", {
      sessionId: session, toolName: "cairn-brain_create",
      toolArgs: { text: `How is ${nodeId} resolved?`, edges: [] }, toolResult: { success: true, id: nodeId },
    }).status).toBe(0);
  }
  expect(invoke("post-tool", {
    sessionId: session, toolName: "cairn-brain_mutate",
    toolArgs: { id: "own-a", answer: "Because of X.", citation: "file://x" }, toolResult: { success: true, id: "own-a" },
  }).status).toBe(0);

  const blocked = invoke("agent-stop", { sessionId: session }).stdout.toString();
  expect(blocked).toContain("block");
  expect(blocked).toContain("own-b");
  expect(telemetryKinds(dbPath)).toContain("ownership_blocked");
  rmSync(dbPath, { force: true });
});

// The host reports resultType "success" for a command that exited non-zero, with the status only in the
// result text. Taken from a live transcript: without this a FAILING check would close its own criterion.
test("a shell result that reports a non-zero exit is not treated as a passing check", () => {
  expect(reportedNonZeroExit({ resultType: "success", textResultForLlm: "\n<shellId: 8 completed with exit code 1>" }))
    .toBe(true);
  expect(reportedNonZeroExit({ resultType: "success", textResultForLlm: "PASS\n<shellId: 4 completed with exit code 0>" }))
    .toBe(false);
  expect(reportedNonZeroExit({ resultType: "success", textResultForLlm: "no status here" })).toBe(false);
  expect(reportedNonZeroExit(undefined)).toBe(false);
});

// End-to-end through the real hook process: an execution tool is DENIED until a contract exists, the stop
// gate then blocks while a criterion is unmet, and only satisfying it releases the turn.
test("the contract gate denies execution, loops the turn, and releases only when criteria are met", () => {
  const dir = join(tmpdir(), `cairn-contract-e2e-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  const dbPath = join(dir, "c.db");
  const hook = join(import.meta.dir, "..", "src", "hosts", "copilot-cli", "hook.ts");
  const env = {
    ...process.env,
    CAIRN_DB_PATH: dbPath,
    CAIRN_ENFORCE_STOP_GATES: "0",
    CAIRN_SKILLS: "0",
    COPILOT_HOME: join(dir, "home"),
  };
  const invoke = (mode: string, payload: object) =>
    spawnSync(process.execPath, [hook, mode], { input: JSON.stringify(payload), env });
  const contractFile = sessionContractPath(dir, "contract-e2e");
  try {
    expect(invoke("user-prompt", { sessionId: "contract-e2e", prompt: "Fix the thing." }).status).toBe(0);
    // 1. Undeclared: the side effect is refused before it happens.
    const denied = invoke("pre-tool", {
      sessionId: "contract-e2e", toolName: "create", toolArgs: { path: join(dir, "out.txt") },
    }).stdout.toString();
    expect(denied).toContain("deny");
    expect(denied).toContain("Declare your plan first");

    // 1b. The instrument the deny NAMES must itself be allowed, or obeying the message is impossible.
    // Both wire forms, because the host may present an MCP tool bare or server-prefixed.
    for (const toolName of ["contract", "cairn-contract"]) {
      expect(invoke("pre-tool", {
        sessionId: "contract-e2e", toolName, toolArgs: { checks: ["bun test"] },
      }).stdout.toString()).not.toContain("deny");
    }

    // 2. Declared: after contract is declared, research and root node in Cairn are checked
    mkdirSync(dirname(contractFile), { recursive: true });
    writeFileSync(contractFile, JSON.stringify({
      criteria: [{ check: "bun test", passed: false, failedFirst: false, evidence: "" }], nudges: 0,
    }));
    expect(invoke("pre-tool", {
      sessionId: "contract-e2e", toolName: "create", toolArgs: { path: join(dir, "out.txt") },
    }).stdout.toString()).toContain("Research in Cairn first");

    expect(invoke("post-tool", {
      sessionId: "contract-e2e",
      toolName: "cairn-brain_search",
      toolArgs: { query: "contract-e2e" },
      toolResult: { success: true },
    }).status).toBe(0);
    expect(invoke("post-tool", {
      sessionId: "contract-e2e",
      toolName: "cairn-brain_create",
      toolArgs: { text: "How to fix contract-e2e?" },
      toolResult: { success: true, id: "contract-e2e-root" },
    }).status).toBe(0);

    expect(invoke("pre-tool", {
      sessionId: "contract-e2e", toolName: "create", toolArgs: { path: join(dir, "out.txt") },
    }).stdout.toString()).not.toContain("deny");

    // 3. Unmet criterion blocks the stop, and the block is bounded and recorded.
    expect(invoke("post-tool", {
      sessionId: "contract-e2e", toolName: "cairn-skill_select", toolArgs: { ids: ["skill-e2e"] },
    }).status).toBe(0);
    // Create child and leaf, then mutate leaf, child, root
    const child = "contract-e2e-child";
    const leaf = "contract-e2e-leaf";
    for (const [id, edges] of [
      [child, ["contract-e2e-root"]],
      [leaf, [child]],
    ] as const) {
      expect(invoke("post-tool", {
        sessionId: "contract-e2e",
        toolName: "cairn-brain_create",
        toolArgs: { text: `How is ${id} resolved?`, edges },
        toolResult: { success: true, id },
      }).status).toBe(0);
    }
    for (const id of [leaf, child, "contract-e2e-root"]) {
      expect(invoke("post-tool", {
        sessionId: "contract-e2e",
        toolName: "cairn-brain_mutate",
        toolArgs: { id, answer: `Resolved ${id}.`, citation: "https://example.com/evidence" },
        toolResult: { success: true, id },
      }).status).toBe(0);
    }
    expect(invoke("post-tool", {
      sessionId: "contract-e2e", timestamp: 30, toolName: "cairn-skill_review", toolArgs: { id: "skill-e2e" },
    }).status).toBe(0);
    expect(invoke("agent-stop", { sessionId: "contract-e2e" }).stdout.toString()).toContain("unmet");
    expect(telemetryKinds(dbPath)).toContain("contract_blocked");

    // 4. An observed run through the real post-tool path releases the turn.
    expect(invoke("post-tool", {
      sessionId: "contract-e2e", toolName: "shell", toolArgs: { command: "bun test" },
      toolResult: { success: true },
    }).status).toBe(0);
    expect(JSON.parse(readFileSync(contractFile, "utf8")).criteria[0].passed).toBe(true);
    expect(invoke("agent-stop", { sessionId: "contract-e2e" }).stdout.toString()).not.toContain("unmet");

    // 5. A new user turn starts with no contract, so the next task must declare its own.
    expect(invoke("user-prompt", { sessionId: "contract-e2e", prompt: "Next task." }).status).toBe(0);
    expect(existsSync(contractFile)).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("contracts remain isolated between concurrent Copilot sessions", () => {
  const dir = join(tmpdir(), `cairn-contract-isolation-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  const dbPath = join(dir, "c.db");
  const hook = join(import.meta.dir, "..", "src", "hosts", "copilot-cli", "hook.ts");
  const env = {
    ...process.env,
    CAIRN_DB_PATH: dbPath,
    CAIRN_ENFORCE_STOP_GATES: "0",
    CAIRN_SKILLS: "0",
    CAIRN_REVIEWER_MOCK: "approve",
    COPILOT_HOME: join(dir, "home"),
  };
  const invoke = (mode: string, payload: object) =>
    spawnSync(process.execPath, [hook, mode], { input: JSON.stringify(payload), env });
  const contract = (sessionId: string) => sessionContractPath(dir, sessionId);
  try {
    for (const sessionId of ["session-a", "session-b"]) {
      expect(invoke("user-prompt", { sessionId, prompt: `Task for ${sessionId}` }).status).toBe(0);
    }
    expect(invoke("post-tool", {
      sessionId: "session-a",
      toolName: "cairn-contract",
      toolArgs: { checks: ["session A output exists"] },
      toolResult: { success: true, accepted: true },
    }).status).toBe(0);
    expect(invoke("post-tool", {
      sessionId: "session-b",
      toolName: "cairn-contract",
      toolArgs: { checks: ["session B output exists"] },
      toolResult: { success: true, accepted: true },
    }).status).toBe(0);

    expect(JSON.parse(readFileSync(contract("session-a"), "utf8")).criteria.map((c: { check: string }) => c.check))
      .toEqual(["session A output exists"]);
    expect(JSON.parse(readFileSync(contract("session-b"), "utf8")).criteria.map((c: { check: string }) => c.check))
      .toEqual(["session B output exists"]);

    expect(invoke("post-tool", {
      sessionId: "session-a",
      toolName: "cairn-contract",
      toolArgs: { satisfied: "session A output exists", evidence: "verified A" },
      toolResult: { success: true, accepted: true },
    }).status).toBe(0);
    expect(JSON.parse(readFileSync(contract("session-a"), "utf8")).criteria[0].passed).toBe(true);
    expect(JSON.parse(readFileSync(contract("session-b"), "utf8")).criteria[0].passed).toBe(false);

    expect(invoke("user-prompt", { sessionId: "session-a", prompt: "Next A task" }).status).toBe(0);
    expect(existsSync(contract("session-a"))).toBe(false);
    expect(existsSync(contract("session-b"))).toBe(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// A client negotiates its tool list at session start, so a session older than the `contract` tool can
// never call it. The per-turn nudge cap cannot see that, because a new prompt clears the contract file and
// re-arms the cap, so such a session is demanded of forever and — worse — has every execution tool denied
// at the start of each turn. Two turns of unanswered demands is the evidence that the tool is absent.
test("a session that can never declare a contract is told once and then released, not bricked", () => {
  const dir = join(tmpdir(), `cairn-contract-missing-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  const dbPath = join(dir, "c.db");
  const hook = join(import.meta.dir, "..", "src", "hosts", "copilot-cli", "hook.ts");
  const env = {
    ...process.env,
    CAIRN_DB_PATH: dbPath,
    CAIRN_ENFORCE_STOP_GATES: "0",
    CAIRN_SKILLS: "0",
    COPILOT_HOME: join(dir, "home"),
  };
  const invoke = (mode: string, payload: object) =>
    spawnSync(process.execPath, [hook, mode], { input: JSON.stringify(payload), env });
  const sid = "contract-missing";
  const stop = () => invoke("agent-stop", { sessionId: sid }).stdout.toString();
  const useSkill = () => invoke("post-tool", {
    sessionId: sid, toolName: "cairn-skill_select", toolArgs: { ids: ["skill-missing"] },
  });
  try {
    // Turn 1: the demand is legitimate and repeats up to its cap. Nothing is released early.
    expect(invoke("user-prompt", { sessionId: sid, prompt: "Do the thing." }).status).toBe(0);
    useSkill();
    completeBrainWorkflow(invoke, sid, { declareContract: false });
    expect(stop()).toContain("declare what done means");
    expect(stop()).toContain("declare what done means");

    // Turn 2: a second turn of unanswered demands proves the instrument is absent, so the turn is told
    // once — in terms the user will hear — instead of being asked a fifth time.
    expect(invoke("user-prompt", { sessionId: sid, prompt: "Next thing." }).status).toBe(0);
    useSkill();
    completeBrainWorkflow(invoke, sid, { declareContract: false });
    let notice = stop();
    for (let i = 0; i < 6 && notice.includes("declare what done means"); i += 1) notice = stop();
    expect(notice).toContain("not reachable from this session");
    expect(notice).toContain("new session is required");
    expect(telemetryKinds(dbPath)).toContain("contract_unavailable");

    // Having said it once, the gate expires rather than repeating: the turn releases and, critically,
    // execution tools stop being denied.
    expect(stop()).not.toContain("not reachable from this session");
    expect(invoke("pre-tool", {
      sessionId: sid, toolName: "create", toolArgs: { path: join(dir, "out.txt") },
    }).stdout.toString()).not.toContain("deny");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an ignored healthy Cairn workflow remains blocked until Cairn is used", () => {
  const id = randomUUID();
  const dbPath = join(tmpdir(), `cairn-ignored-workflow-${id}.db`);
  const hook = join(import.meta.dir, "..", "src", "hosts", "copilot-cli", "hook.ts");
  const env = {
    ...process.env,
    CAIRN_DB_PATH: dbPath,
    CAIRN_ENFORCE_STOP_GATES: "0",
  };
  const invoke = (mode: string, payload: object) =>
    spawnSync(process.execPath, [hook, mode], { input: JSON.stringify(payload), env });

  expect(invoke("user-prompt", { sessionId: "ignored-workflow", prompt: "Finish the task." }).status).toBe(0);
  invoke("post-tool", { sessionId: "ignored-workflow", toolName: "edit", toolArgs: { path: "a.ts" }, toolResult: { success: true } });
  expect(invoke("agent-stop", { sessionId: "ignored-workflow" }).stdout.toString())
    .toContain("resolve this task in the brain");
  expect(telemetryKinds(dbPath)).not.toContain("visibility_failure");
  expect(invoke("agent-stop", { sessionId: "ignored-workflow" }).stdout.toString())
    .toContain("resolve this task in the brain");
  expect(invoke("agent-stop", { sessionId: "ignored-workflow" }).stdout.toString())
    .not.toBe("{}");
  rmSync(dbPath, { force: true });
});

test("adopting a searched node ends the turn, but an unsearched id cannot fake reuse", () => {
  const id = randomUUID();
  const dbPath = join(tmpdir(), `cairn-brain-reuse-${id}.db`);
  const hook = join(import.meta.dir, "..", "src", "hosts", "copilot-cli", "hook.ts");
  const env = { ...process.env, CAIRN_DB_PATH: dbPath, CAIRN_ENFORCE_STOP_GATES: "1", CAIRN_SKILLS: "1" };
  const invoke = (mode: string, payload: object) =>
    spawnSync(process.execPath, [hook, mode], { input: JSON.stringify(payload), env });
  const session = "brain-reuse";
  const existing = "11111111-2222-3333-4444-555555555555";
  const unsearched = "99999999-8888-7777-6666-555555555555";

  expect(invoke("user-prompt", { sessionId: session, prompt: "Resolve the task." }).status).toBe(0);
  satisfyContract(dbPath, session, "the task is resolved");
  expect(invoke("post-tool", {
    sessionId: session,
    toolName: "cairn-skill_select",
    toolArgs: { ids: ["software implementation"] },
    toolResult: { success: true, selected: [{ id: "skill-1" }] },
  }).status).toBe(0);
  expect(invoke("post-tool", {
    sessionId: session,
    toolName: "cairn-brain_search",
    toolArgs: { query: "the task" },
    toolResult: { success: true, textResultForLlm: JSON.stringify([{ id: existing, text: "How was it resolved?" }]) },
  }).status).toBe(0);

  // Searching alone must not release the turn, and must ask for reuse rather than claim nothing was recorded.
  const searched = invoke("agent-stop", { sessionId: session }).stdout.toString();
  expect(searched).toContain("Do not create duplicate nodes");
  expect(searched).not.toContain("without recording anything");

  // Mutating an id this turn never saw is not evidence of reuse.
  expect(invoke("post-tool", {
    sessionId: session,
    toolName: "cairn-brain_mutate",
    toolArgs: { id: unsearched, edges: ["x"] },
    toolResult: { success: true, id: unsearched },
  }).status).toBe(0);
  expect(invoke("agent-stop", { sessionId: session }).stdout.toString()).not.toBe("{}");

  // Adopting the node the search actually returned completes the turn without a single duplicate node.
  expect(invoke("post-tool", {
    sessionId: session,
    toolName: "cairn-brain_mutate",
    toolArgs: { id: existing, edges: ["prior-evidence"] },
    toolResult: { success: true, id: existing },
  }).status).toBe(0);
  const released = invoke("agent-stop", { sessionId: session }).stdout.toString();
  expect(released).not.toContain("Do NOT");
  expect(invoke("agent-stop", { sessionId: session }).stdout.toString()).toBe("{}");
  rmSync(dbPath, { force: true });
}, 60_000);

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

test("system reminder prompts preserve the turn and a genuine user prompt resets it", () => {
  const id = randomUUID();
  const home = join(tmpdir(), `cairn-stop-cap-home-${id}`);
  const hook = join(import.meta.dir, "..", "src", "hosts", "copilot-cli", "hook.ts");
  const env = { ...process.env, USERPROFILE: home, HOME: home };
  const invoke = (mode: string, payload: object = { sessionId: "session-cap" }) =>
    spawnSync(process.execPath, [hook, mode], { input: JSON.stringify(payload), env });

  expect(invoke("user-prompt", { sessionId: "session-cap", prompt: "first" }).status).toBe(0);
  invoke("post-tool", { sessionId: "session-cap", toolName: "edit", toolArgs: { path: "a.ts" }, toolResult: { success: true } });
  expect(invoke("agent-stop", { sessionId: "session-cap" }).stdout.toString()).toContain('"decision":"block"');
  expect(invoke("user-prompt", {
    sessionId: "session-cap",
    prompt: "<cairn-internal>continue required workflow</cairn-internal>",
  }).stdout.toString()).toBe("{}");
  expect(invoke("agent-stop", { sessionId: "session-cap" }).stdout.toString()).toContain('"decision":"block"');
  expect(invoke("user-prompt", {
    sessionId: "session-cap",
    prompt: "<system_reminder>continue required workflow</system_reminder>",
  }).stdout.toString()).toBe("{}");
  expect(invoke("agent-stop", { sessionId: "session-cap" }).stdout.toString()).toContain('"decision":"block"');
  expect(invoke("agent-stop", { sessionId: "session-cap" }).stdout.toString()).not.toBe("{}");

  expect(invoke("user-prompt", { sessionId: "session-cap", prompt: "second" }).status).toBe(0);
  invoke("post-tool", { sessionId: "session-cap", toolName: "edit", toolArgs: { path: "a.ts" }, toolResult: { success: true } });
  expect(invoke("agent-stop", { sessionId: "session-cap" }).stdout.toString()).toContain('"decision":"block"');
});

test("an undeclared contract nudge is bounded, so a session that cannot declare one is not bricked", () => {
  const id = randomUUID();
  const home = join(tmpdir(), `cairn-contract-bound-home-${id}`);
  const dir = join(tmpdir(), `cairn-contract-bound-${id}`);
  mkdirSync(dir, { recursive: true });
  const dbPath = join(dir, "cairn.db");
  const hook = join(import.meta.dir, "..", "src", "hosts", "copilot-cli", "hook.ts");
  const env = {
    ...process.env, USERPROFILE: home, HOME: home, CAIRN_DB_PATH: dbPath,
    CAIRN_CONTRACT_CAP: "2",
  };
  const invoke = (mode: string, payload: object) => spawnSync(process.execPath, [hook, mode], { input: JSON.stringify(payload), env });
  const session = "contract-bound";
  expect(invoke("user-prompt", { sessionId: session, prompt: "Do the task." }).status).toBe(0);
  invoke("post-tool", { sessionId: session, toolName: "edit", toolArgs: { path: "a.ts" }, toolResult: { success: true } });
  completeBrainWorkflow(invoke, session, { declareContract: false });

  // Never declaring anything: the gate asks, but only while it can still be acted on.
  const reasons: string[] = [];
  let released = false;
  for (let attempt = 0; attempt < 12 && !released; attempt++) {
    const reason = invoke("agent-stop", { sessionId: session }).stdout.toString();
    reasons.push(reason);
    released = reason === "{}";
  }
  const asked = reasons.filter((reason) => reason.includes("declare what done means")).length;
  expect(asked).toBeGreaterThan(0);
  expect(asked).toBeLessThanOrEqual(3);
  expect(released).toBe(true);

  // Once exhausted the pre-tool deny lifts too, otherwise the turn could never write anything again.
  const write = invoke("pre-tool", { sessionId: session, toolName: "edit", toolArgs: { path: "a.ts" } });
  expect(write.stdout.toString()).not.toContain("Declare your plan first");
});

test("extractResultNodeId extracts node ID across diverse tool result structures", () => {
  // 1. Direct id on result object
  expect(extractResultNodeId({ id: "node-1" })).toBe("node-1");

  // 2. MCP content array with JSON text
  expect(extractResultNodeId({
    content: [{ type: "text", text: JSON.stringify({ id: "node-mcp-2", url: "http://localhost/node/2" }) }],
  })).toBe("node-mcp-2");

  // 3. textResultForLlm JSON string
  expect(extractResultNodeId({
    textResultForLlm: JSON.stringify({ id: "node-llm-3" }),
  })).toBe("node-llm-3");

  // 4. args.id fallback
  expect(extractResultNodeId({}, { id: "node-args-4" })).toBe("node-args-4");

  // 5. Empty/null safety
  expect(extractResultNodeId(null)).toBe("");
  expect(extractResultNodeId(undefined)).toBe("");
  expect(extractResultNodeId({})).toBe("");
});

test("post-tool tracks MCP created nodes, mutations, and deletes without false unresolved stops", () => {
  const id = randomUUID();
  const dbPath = join(tmpdir(), `cairn-node-lifecycle-${id}.db`);
  const hook = join(import.meta.dir, "..", "src", "hosts", "copilot-cli", "hook.ts");
  const env = { ...process.env, CAIRN_DB_PATH: dbPath, CAIRN_ENFORCE_STOP_GATES: "1" };
  const invoke = (mode: string, payload: object) =>
    spawnSync(process.execPath, [hook, mode], { input: JSON.stringify(payload), env });
  const session = `node-lifecycle-${id}`;

  try {
    // 1. Start user turn & satisfy plan
    invoke("user-prompt", { sessionId: session, prompt: "Resolve decomposition task." });
    satisfyContract(dbPath, session, "all nodes resolved");

    // 2. Search brain
    invoke("post-tool", {
      sessionId: session,
      toolName: "cairn-brain_search",
      toolArgs: { query: "decomposition" },
      toolResult: { success: true },
    });

    // 3. Create root and child using standard MCP content format
    invoke("post-tool", {
      sessionId: session,
      toolName: "cairn-brain_create",
      toolArgs: { text: "What is root?" },
      toolResult: {
        content: [{ type: "text", text: JSON.stringify({ id: "node-root-1", url: "url1" }) }],
      },
    });
    invoke("post-tool", {
      sessionId: session,
      toolName: "cairn-brain_create",
      toolArgs: { text: "What is child?" },
      toolResult: {
        content: [{ type: "text", text: JSON.stringify({ id: "node-child-2", url: "url2" }) }],
      },
    });
    invoke("post-tool", {
      sessionId: session,
      toolName: "cairn-brain_create",
      toolArgs: { text: "What is leaf?" },
      toolResult: {
        content: [{ type: "text", text: JSON.stringify({ id: "node-leaf-3", url: "url3" }) }],
      },
    });

    // Run an execution tool in the turn
    invoke("post-tool", {
      sessionId: session,
      toolName: "edit",
      toolArgs: { path: "a.ts" },
      toolResult: { success: true },
    });

    // 4. Stop should block because created nodes are not yet answered
    const stopBlocked = invoke("agent-stop", { sessionId: session }).stdout.toString();
    expect(stopBlocked).toContain("block");

    // 5. Answer child and leaf nodes
    invoke("post-tool", {
      sessionId: session,
      toolName: "cairn-brain_mutate",
      toolArgs: { id: "node-leaf-3", answer: "Leaf solved", citation: "https://example.com" },
      toolResult: { success: true },
    });
    invoke("post-tool", {
      sessionId: session,
      toolName: "cairn-brain_mutate",
      toolArgs: { id: "node-child-2", answer: "Child solved", citation: "https://example.com" },
      toolResult: { success: true },
    });

    // 6. Answer root node (synthesize)
    invoke("post-tool", {
      sessionId: session,
      toolName: "cairn-brain_mutate",
      toolArgs: { id: "node-root-1", answer: "Root solved", citation: "https://example.com" },
      toolResult: { success: true },
    });

    // 7. Stop gate should now allow turn release cleanly without complaining about unresolved nodes
    const stopReleased = invoke("agent-stop", { sessionId: session }).stdout.toString();
    expect(stopReleased).toContain("completed every requested task");
    expect(invoke("agent-stop", { sessionId: session }).stdout.toString()).toBe("{}");
  } finally {
    rmSync(dbPath, { force: true });
  }
});

test("the contract gate never denies delegation, so Cairn can still reach a subagent", () => {
  const id = randomUUID();
  const home = join(tmpdir(), `cairn-task-gate-home-${id}`);
  const dbPath = join(tmpdir(), `cairn-task-gate-${id}.db`);
  const hook = join(import.meta.dir, "..", "src", "hosts", "copilot-cli", "hook.ts");
  const env = { ...process.env, USERPROFILE: home, HOME: home, CAIRN_DB_PATH: dbPath };
  const invoke = (mode: string, payload: object) => spawnSync(process.execPath, [hook, mode], { input: JSON.stringify(payload), env });
  expect(invoke("user-prompt", { sessionId: "task-gate", prompt: "Delegate some research." }).status).toBe(0);

  const spawned = invoke("pre-tool", {
    sessionId: "task-gate",
    toolCallId: "child-1",
    toolName: "task",
    toolArgs: { agent_type: "explore", prompt: "Look into it." },
  });
  expect(spawned.stdout.toString()).not.toContain("Declare your contract first");

  // An ordinary write on the same undeclared turn is still denied, so the exclusion is delegation-only.
  const write = invoke("pre-tool", { sessionId: "task-gate", toolName: "edit", toolArgs: { path: "a.ts" } });
  expect(write.stdout.toString()).toContain("Declare your plan first");
});

test("a subagent runs Cairn: it receives the full workflow and is held to the same gate", () => {
  const dbPath = join(tmpdir(), `cairn-subagent-runs-cairn-${randomUUID()}.db`);
  const hook = join(import.meta.dir, "..", "src", "hosts", "copilot-cli", "hook.ts");
  const env = { ...process.env, CAIRN_DB_PATH: dbPath };
  const invoke = (mode: string, payload: object) =>
    spawnSync(process.execPath, [hook, mode], { input: JSON.stringify(payload), env });
  for (const sessionId of ["toolu_01BJn8LTK5VRTyb8CGjzhAmS", `call_${randomUUID()}`]) {
    const start = invoke("user-prompt", { sessionId, prompt: "Search the repo for the retry policy." });
    expect(start.stdout.toString()).toContain("Brain workflow");
    invoke("post-tool", { sessionId, toolName: "edit", toolArgs: { path: "a.ts" }, toolResult: { success: true } });
    expect(invoke("agent-stop", { sessionId, transcriptPath: "" }).stdout.toString())
      .toContain("block");
  }
});

test("brain node floor scales with execution and keeps fail-closed invariants", () => {
  expect(requiredBrainNodes(0)).toBe(1);
  expect(requiredBrainNodes(2)).toBe(1);
  expect(countsAsExecution("view")).toBe(false);
  expect(countsAsExecution("powershell", { command: "rg pattern src" })).toBe(false);
  expect(countsAsExecution("powershell", { command: "git commit -m x" })).toBe(true);
  expect(countsAsExecution("edit")).toBe(true);
  expect(countsAsExecution("cairn-brain_create")).toBe(false);
  // The gate's own instrument is never an execution tool: the pre-tool deny names `contract` as the way
  // out, so classifying it as execution denies the only exit from the gate and deadlocks the session.
  expect(countsAsExecution("contract")).toBe(false);
  expect(countsAsExecution("cairn-contract")).toBe(false);
  // A read-only probe is not a write just because its code contains an arrow function: `=>` is not the
  // `>` redirect. This misread also removed the last escape from the deadlock above, since it denied the
  // read-only shell an instrument-less session would use to declare through Cairn's own API.
  expect(countsAsExecution("powershell", { command: "bun -e 'const f = () => 1; console.log(f())'" }))
    .toBe(false);
  // The real file redirect it must still catch. `2>&1` is deliberately NOT one: it merges streams for
  // the pipeline rather than writing anything, which is why the pattern excludes a following `>` or `&`.
  expect(countsAsExecution("powershell", { command: "echo hi > out.txt" })).toBe(true);
  expect(countsAsExecution("powershell", { command: "bun test 2>&1 | cat" })).toBe(false);

  const resolved = {
    brainUsed: true, brainSearched: true, brainCreatedCount: 2, brainAnsweredCount: 2,
    rootSynthesized: true, skillUsed: true, stopNudges: 0, strict: true,
  };
  // A read-only turn that fully resolved a root plus one child may finish.
  expect(stopDecision({ ...resolved, minimumBrainNodes: requiredBrainNodes(0) })).toEqual({ file: "" });
  // The same evidence on a turn that changed something may finish once resolved.
  expect(stopDecision({ ...resolved, minimumBrainNodes: requiredBrainNodes(1) }))
    .toEqual({ file: "" });
  // Skipping Cairn stays blocked regardless of how cheap the turn was.
  expect(stopDecision({
    ...resolved, brainSearched: false, brainCreatedCount: 0, brainAnsweredCount: 0,
    rootSynthesized: false, minimumBrainNodes: requiredBrainNodes(0),
  })).toEqual({ file: "turn-reminder.md" });
});

test("a scratch probe that reads data does not raise the decomposition floor", () => {
  const probe = "$code | Out-File -Encoding utf8 audit4.ts; bun run audit4.ts; Remove-Item audit4.ts";
  // The fail-closed action gate must still see the write, or an unfinished workflow could smuggle edits.
  expect(countsAsExecution("powershell", { command: probe })).toBe(true);
  // The floor must not: nothing outlived the command, so the turn changed nothing.
  expect(scratchOnlyShellCommand(probe)).toBe(true);
  expect(changesDurableState("powershell", { command: probe })).toBe(false);

  // Writes that outlive the command remain durable work.
  expect(changesDurableState("powershell", { command: "Set-Content src/app.ts 'x'" })).toBe(true);
  expect(changesDurableState("powershell", { command: "echo hi > out.txt" })).toBe(true);
  expect(changesDurableState("edit")).toBe(true);
  // Deleting a real file is not a scratch probe: it creates nothing to offset.
  expect(changesDurableState("powershell", { command: "Remove-Item C:\\repo\\keep.txt" })).toBe(true);
  // A scratch file cannot launder a durable verb in the same command.
  expect(changesDurableState("powershell", {
    command: "$c | Out-File t.ts; git commit -m x; Remove-Item t.ts",
  })).toBe(true);
  // Pure reads are unchanged.
  expect(changesDurableState("powershell", { command: "rg pattern src" })).toBe(false);
});

// -- The completion loop is general: it knows nothing about the task ------------------------------
// Two differently shaped tasks run through the SAME code path with no task-specific branch: one whose
// done-ness is decided by running something, one whose done-ness is an artifact no shell can judge.
// This is the regression guard against re-introducing hardcoded phrase/extension/command lists.
test("the contract loop blocks until declared criteria are met, whatever shape the task has", () => {
  const dir = join(tmpdir(), `cairn-contract-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  const prior = process.env.CAIRN_DB_PATH;
  process.env.CAIRN_DB_PATH = join(dir, "c.db");
  try {
    const contract = require("../src/hosts/copilot-cli/contract") as typeof import("../src/hosts/copilot-cli/contract");

    // 1. A turn with durable changes that declared nothing is never released.
    contract.clearContract();
    expect(contract.contractStopReason(true)).toContain("declare what done means");

    // 2. Non-executable work closes by naming the artifact.
    expect(contract.declareContract(["a three-line poem is written in the reply"]).criteria).toHaveLength(1);
    expect(contract.contractStopReason(true)).toContain("unmet");
    expect(contract.satisfyCriterion("a three-line poem is written in the reply", "").error)
      .toContain("evidence is required");
    expect(contract.satisfyCriterion("a three-line poem is written in the reply", "3 lines in the reply").remaining)
      .toEqual([]);
    expect(contract.contractStopReason(true)).toBe("");

    // 3. Executable work: an observed successful run of the declared check closes it.
    contract.clearContract();
    contract.declareContract(["bun test"]);
    expect(contract.contractStopReason(true)).toContain("unmet");
    // 3a. But only a command that RAN it. Merely naming the check must never close it, or the proof is
    // satisfied by quoting the proof — observed live, where the command that DECLARED the contract closed
    // every criterion in it, because a declaration necessarily contains its own check text.
    contract.recordObservedRun('echo "bun test"', true);
    contract.recordObservedRun("bun -e 'declareContract([`bun test`])'", true);
    contract.recordObservedRun("rg 'bun test' tests", true);
    expect(contract.contractStopReason(true)).toContain("unmet");
    // 3b. A real invocation closes it, including as one segment of a longer command line, with arguments.
    contract.recordObservedRun("cd repo; bun test --coverage", true);
    expect(contract.contractStopReason(true)).toBe("");

    // 4. Assertion closes non-runnable work: the gate forces delivery, it does not judge quality.
    contract.clearContract();
    contract.declareContract(["the config is updated"]);
    expect(contract.contractStopReason(true)).toContain("unmet");
    contract.satisfyCriterion("the config is updated", "edited settings.json");
    expect(contract.contractStopReason(true)).toBe("");

    // 4b. The ratchet: criteria can be ADDED, but adding never removes, rewords, or resets an existing one.
    contract.clearContract();
    contract.declareContract(["the config is updated"]);
    contract.satisfyCriterion("the config is updated", "edited settings.json");
    const ratchet = contract.declareContract(["the config is updated", "a new runnable check"]).criteria ?? [];
    expect(ratchet).toHaveLength(2);
    expect(ratchet[0]?.passed).toBe(true);
    expect(contract.contractStopReason(true)).toContain("unmet");
    contract.recordObservedRun("a new runnable check", true);
    expect(contract.contractStopReason(true)).toBe("");

    // 5. Hard block: declared criteria never escape until satisfied.
    contract.clearContract();
    contract.declareContract(["an impossible thing"]);
    const cap = Number(process.env.CAIRN_CONTRACT_CAP || "3");
    for (let i = 0; i < cap + 5; i += 1) contract.noteContractNudge();
    expect(contract.contractStopReason(true)).toContain("These declared plan items are unmet: an impossible thing");
    expect(contract.contractExhausted()).toBe(false);
  } finally {
    if (prior == null) delete process.env.CAIRN_DB_PATH; else process.env.CAIRN_DB_PATH = prior;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("conversational turn with no execution tools allows fast response without stop-gate blocks", () => {
  const id = randomUUID();
  const dbPath = join(tmpdir(), `cairn-fast-path-${id}.db`);
  const hook = join(import.meta.dir, "..", "src", "hosts", "copilot-cli", "hook.ts");
  const env = { ...process.env, CAIRN_DB_PATH: dbPath, CAIRN_ENFORCE_STOP_GATES: "1" };
  const invoke = (mode: string, payload: object) =>
    spawnSync(process.execPath, [hook, mode], { input: JSON.stringify(payload), env });
  const session = `fast-path-${id}`;

  try {
    // Conversational prompt (e.g. user asks a quick question)
    expect(invoke("user-prompt", { sessionId: session, prompt: "What is Cairn?" }).status).toBe(0);

    // Read-only tools like view, grep, glob can be used freely
    expect(invoke("pre-tool", { sessionId: session, toolName: "view", toolArgs: { path: "README.md" } }).stdout.toString()).toBe("{}");
    expect(invoke("post-tool", { sessionId: session, toolName: "view", toolArgs: { path: "README.md" }, toolResult: { content: "Cairn docs" } }).status).toBe(0);

    // Turn with no execution/mutation tools completes cleanly without stop-gate nagging
    const stopResponse = invoke("agent-stop", { sessionId: session }).stdout.toString();
    expect(stopResponse).toBe("{}");
  } finally {
    rmSync(dbPath, { force: true });
  }
});

test("complete pre-tool gate transitions and verifies all error messages", () => {
  const id = randomUUID();
  const dbPath = join(tmpdir(), `cairn-pre-tool-messages-${id}.db`);
  const hook = join(import.meta.dir, "..", "src", "hosts", "copilot-cli", "hook.ts");
  const env = { ...process.env, CAIRN_DB_PATH: dbPath, CAIRN_ENFORCE_STOP_GATES: "1" };
  const invoke = (mode: string, payload: object) =>
    spawnSync(process.execPath, [hook, mode], { input: JSON.stringify(payload), env });
  const session = `pre-tool-msg-${id}`;

  try {
    invoke("user-prompt", { sessionId: session, prompt: "Refactor codebase." });

    // 1. Stage 1: No plan declared -> denied with CONTRACT_DECLARE_REASON
    const stage1 = invoke("pre-tool", {
      sessionId: session,
      toolName: "edit",
      toolArgs: { path: "src/app.ts", old_str: "1", new_str: "2" },
    }).stdout.toString();
    const stage1Json = JSON.parse(stage1);
    expect(stage1Json.permissionDecision).toBe("deny");
    expect(stage1Json.permissionDecisionReason).toBe(
      "Declare your plan first: call the `plan` (or `contract`) tool with the tasks defining done for this task. The requested side effect was not executed."
    );

    // Declare plan
    const planPost = invoke("post-tool", {
      sessionId: session,
      toolName: "plan",
      toolArgs: { tasks: ["Update app", "bun test"] },
      toolResult: { accepted: true },
    }).stdout.toString();
    const planPostJson = JSON.parse(planPost);
    expect(planPostJson.additionalContext).toContain("Plan state:");
    expect(planPostJson.additionalContext).toContain("- [ ] Update app");
    expect(planPostJson.additionalContext).toContain("- [ ] bun test");

    // 2. Stage 2: Plan declared, but no brain_search -> denied with research reason
    const stage2 = invoke("pre-tool", {
      sessionId: session,
      toolName: "edit",
      toolArgs: { path: "src/app.ts", old_str: "1", new_str: "2" },
    }).stdout.toString();
    const stage2Json = JSON.parse(stage2);
    expect(stage2Json.permissionDecision).toBe("deny");
    expect(stage2Json.permissionDecisionReason).toBe(
      "Research in Cairn first: call `brain_search` to check for relevant prior knowledge before modifying files or executing changes."
    );

    // Perform brain_search
    const searchPost = invoke("post-tool", {
      sessionId: session,
      toolName: "brain_search",
      toolArgs: { query: "app refactor" },
      toolResult: { success: true },
    }).stdout.toString();
    expect(JSON.parse(searchPost).additionalContext).toBeDefined();

    // 3. Stage 3: Searched, but no root node created -> denied with decomposition reason
    const stage3 = invoke("pre-tool", {
      sessionId: session,
      toolName: "edit",
      toolArgs: { path: "src/app.ts", old_str: "1", new_str: "2" },
    }).stdout.toString();
    const stage3Json = JSON.parse(stage3);
    expect(stage3Json.permissionDecision).toBe("deny");
    expect(stage3Json.permissionDecisionReason).toBe(
      "Decompose your task in Cairn first: declare your root question with `brain_create` (or reuse a covering node with `brain_mutate`) before modifying files or executing changes."
    );

    // Create root node
    invoke("post-tool", {
      sessionId: session,
      toolName: "brain_create",
      toolArgs: { text: "How to update app.ts safely?" },
      toolResult: { success: true, id: "root-app-1" },
    });

    // 4. Stage 4: Plan + Search + Root Node established -> edit allowed!
    const stage4 = invoke("pre-tool", {
      sessionId: session,
      toolName: "edit",
      toolArgs: { path: "src/app.ts", old_str: "1", new_str: "2" },
    }).stdout.toString();
    expect(stage4).toBe("{}");

    // Execute the edit
    invoke("post-tool", {
      sessionId: session,
      toolName: "edit",
      toolArgs: { path: "src/app.ts", old_str: "1", new_str: "2" },
      toolResult: { success: true },
    });

    // 5. Stage 5: Stop gate deficit shows open unanswered node
    const stopGate = invoke("agent-stop", { sessionId: session }).stdout.toString();
    const stopGateJson = JSON.parse(stopGate);
    expect(stopGateJson.decision).toBe("block");
    expect(stopGateJson.reason).toContain("Unresolved nodes to answer: root-app-1");

    // Mutate and answer root node, and create + answer decomposition children
    invoke("post-tool", {
      sessionId: session,
      toolName: "brain_create",
      toolArgs: { text: "What is subtask 1?" },
      toolResult: { success: true, id: "child-app-1" },
    });
    invoke("post-tool", {
      sessionId: session,
      toolName: "brain_create",
      toolArgs: { text: "What is subtask 2?" },
      toolResult: { success: true, id: "child-app-2" },
    });
    invoke("post-tool", {
      sessionId: session,
      toolName: "brain_mutate",
      toolArgs: { id: "child-app-1", answer: "Child 1 solved.", citation: "https://example.com" },
      toolResult: { success: true, id: "child-app-1" },
    });
    invoke("post-tool", {
      sessionId: session,
      toolName: "brain_mutate",
      toolArgs: { id: "child-app-2", answer: "Child 2 solved.", citation: "https://example.com" },
      toolResult: { success: true, id: "child-app-2" },
    });
    invoke("post-tool", {
      sessionId: session,
      toolName: "brain_mutate",
      toolArgs: { id: "root-app-1", answer: "Refactored safely.", citation: "https://example.com" },
      toolResult: { success: true, id: "root-app-1" },
    });

    // 6. Stage 6: Stop gate shows unmet plan items
    const stopPlan = invoke("agent-stop", { sessionId: session }).stdout.toString();
    const stopPlanJson = JSON.parse(stopPlan);
    expect(stopPlanJson.decision).toBe("block");
    expect(stopPlanJson.reason).toContain("These declared plan items are unmet: Update app | bun test");

    // Satisfy first item via plan tool
    const updatePost = invoke("post-tool", {
      sessionId: session,
      toolName: "plan",
      toolArgs: { completed: "Update app", evidence: "src/app.ts updated" },
      toolResult: { accepted: true },
    }).stdout.toString();
    const updatePostJson = JSON.parse(updatePost);
    expect(updatePostJson.additionalContext).toContain("- [x] Update app");
    expect(updatePostJson.additionalContext).toContain("- [ ] bun test");

    // Satisfy second item via command execution
    invoke("post-tool", {
      sessionId: session,
      toolName: "powershell",
      toolArgs: { command: "bun test" },
      toolResult: { success: true, textResultForLlm: "<shellId: 1 completed with exit code 0>" },
    });

    // 7. Stage 7: Both brain and plan satisfied -> completes!
    const finalStop = invoke("agent-stop", { sessionId: session }).stdout.toString();
    expect(finalStop).toContain("completed every requested task");
    expect(invoke("agent-stop", { sessionId: session }).stdout.toString()).toBe("{}");
  } finally {
    rmSync(dbPath, { force: true });
  }
});

