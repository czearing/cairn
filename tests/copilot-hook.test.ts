import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  gateDecision,
  internalContext,
  isTool,
  latestHumanUserMarker,
  postToolFiles,
  STOP_CAP,
  shouldStartUserTurn,
  stopDecision,
  synchronizeTurnState,
} from "../src/hosts/copilot-cli/hook";

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

test("stopDecision requires skill search before brain use", () => {
  expect(stopDecision({ brainUsed: false, skillUsed: false, reviewed: false, stopNudges: 0 })).toEqual({ file: "skill-search-reminder.md" });
});

test("stopDecision nudges skill-review when a skill was used but not reviewed before ending", () => {
  expect(stopDecision({ brainUsed: true, skillUsed: true, reviewed: false, stopNudges: 0 })).toEqual({ file: "skill-review.md" });
});

test("stopDecision allows the turn to end when the skill was reviewed", () => {
  expect(stopDecision({ brainUsed: true, skillUsed: true, reviewed: true, stopNudges: 0 })).toEqual({ file: "" });
});

test("stopDecision requires skill search even when the brain was used", () => {
  expect(stopDecision({ brainUsed: true, skillUsed: false, reviewed: false, stopNudges: 0 })).toEqual({ file: "skill-search-reminder.md" });
});

test("stopDecision stops nudging once the per-turn cap is reached (no infinite loop)", () => {
  expect(stopDecision({ brainUsed: false, skillUsed: true, reviewed: false, stopNudges: STOP_CAP })).toEqual({ file: "" });
});

test("a new transcript user marker resets stale turn compliance", () => {
  const previous = {
    brainUsed: true,
    skillUsed: true,
    reviewed: true,
    stopNudges: 1,
    stopBlocked: false,
    userMarker: "old-user",
  };
  expect(synchronizeTurnState(previous, "new-user")).toEqual({
    brainUsed: false,
    skillUsed: false,
    reviewed: false,
    stopNudges: 0,
    stopBlocked: false,
    userMarker: "new-user",
  });

  expect(synchronizeTurnState(previous, "old-user")).toBe(previous);
});

test("latest user marker ignores cairn and host reminder envelopes", () => {
  const human = JSON.stringify({
    type: "user.message",
    id: "human-1",
    data: { content: "fix the component" },
  });

  const reminder = JSON.stringify({
    type: "user.message",
    id: "reminder-1",
    data: { content: "<cairn-internal>record this turn</cairn-internal>" },
  });
  expect(latestHumanUserMarker([human, reminder])).toBe("human-1");
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

test("subagentStop durably queues the subagent's latest skill_review", () => {
  const id = randomUUID();
  const dbPath = join(tmpdir(), `cairn-review-hook-${id}.db`);
  const home = join(tmpdir(), `cairn-review-hook-home-${id}`);
  const transcriptPath = join(tmpdir(), `cairn-review-hook-${id}.jsonl`);
  writeFileSync(transcriptPath, [
    JSON.stringify({ type: "subagent.started", agentId: "agent-1", timestamp: 10, data: { agentDisplayName: "Reviewer" } }),
    JSON.stringify({ type: "assistant.message", agentId: "agent-1", timestamp: 11, data: { content: "Finished review." } }),
    JSON.stringify({ type: "tool.execution_start", agentId: "agent-1", timestamp: 12, data: { toolCallId: "review-1", toolName: "cairn-skill_review", arguments: { id: "skill-1" } } }),
    JSON.stringify({ type: "tool.execution_complete", agentId: "agent-1", timestamp: 13, data: { toolCallId: "review-1", success: true } }),
  ].join("\n"));
  const hook = join(import.meta.dir, "..", "src", "hosts", "copilot-cli", "hook.ts");
  const env = { ...process.env, USERPROFILE: home, HOME: home, CAIRN_DB_PATH: dbPath, CAIRN_MAX_LEARNERS: "0", CAIRN_SKILLS: "1" };
  const invoke = (mode: string, payload: object) => spawnSync(process.execPath, [hook, mode], { input: JSON.stringify(payload), env });
  expect(invoke("post-tool", { sessionId: "session-1", toolName: "cairn-brain_search", toolArgs: {} }).status).toBe(0);
  expect(invoke("post-tool", { sessionId: "session-1", agentId: "agent-1", toolName: "cairn-skill_search", toolArgs: {} }).status).toBe(0);
  const run = invoke("subagent-stop", { sessionId: "session-1", agentId: "agent-1", transcriptPath });
  expect(run.status).toBe(0);
  const d = new Database(dbPath);
  const jobs = d.query("SELECT skill_id, status FROM review_jobs").all() as { skill_id: string; status: string }[];
  d.close();
  expect(jobs).toEqual([{ skill_id: "skill-1", status: "pending" }]);
  expect(invoke("agent-stop", { sessionId: "session-1" }).stdout.toString()).toBe("{}");
});

test("successful postToolUse queues review before tool completion is written and survives hook restart", () => {
  const id = randomUUID();
  const dbPath = join(tmpdir(), `cairn-review-stop-${id}.db`);
  const home = join(tmpdir(), `cairn-review-home-${id}`);
  const transcriptPath = join(home, ".copilot", "session-state", "session-2", "events.jsonl");
  mkdirSync(join(home, ".copilot", "session-state", "session-2"), { recursive: true });
  writeFileSync(transcriptPath, JSON.stringify({
    type: "tool.execution_start",
    timestamp: 20,
    data: { toolCallId: "review-2", toolName: "cairn-skill_review", arguments: { id: "skill-2" } },
  }));
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
  const d = new Database(dbPath);
  const jobs = d.query("SELECT skill_id, status FROM review_jobs").all() as { skill_id: string; status: string }[];
  d.close();
  expect(jobs).toEqual([{ skill_id: "skill-2", status: "pending" }]);
  const stop = invoke("agent-stop", { sessionId: "session-2" });
  expect(stop.status).toBe(0);
  expect(stop.stdout.toString()).toBe("{}");
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
