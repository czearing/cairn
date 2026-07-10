import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { postToolFiles, stopDecision, gateDecision, internalContext, isTool, STOP_CAP } from "../src/hosts/copilot-cli/hook";

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

test("stopDecision nudges turn-reminder when the brain was not used this turn", () => {
  expect(stopDecision({ brainUsed: false, skillUsed: false, reviewed: false, stopNudges: 0 })).toEqual({ file: "turn-reminder.md" });
});

test("stopDecision nudges skill-review when a skill was used but not reviewed before ending", () => {
  expect(stopDecision({ brainUsed: true, skillUsed: true, reviewed: false, stopNudges: 0 })).toEqual({ file: "skill-review.md" });
});

test("stopDecision allows the turn to end when the skill was reviewed", () => {
  expect(stopDecision({ brainUsed: true, skillUsed: true, reviewed: true, stopNudges: 0 })).toEqual({ file: "" });
});

test("stopDecision allows the turn to end when no skill was used", () => {
  expect(stopDecision({ brainUsed: true, skillUsed: false, reviewed: false, stopNudges: 0 })).toEqual({ file: "" });
});

test("stopDecision stops nudging once the per-turn cap is reached (no infinite loop)", () => {
  expect(stopDecision({ brainUsed: false, skillUsed: true, reviewed: false, stopNudges: STOP_CAP })).toEqual({ file: "" });
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

test("an accepted queued review satisfies agentStop even with no worker capacity", () => {
  const id = randomUUID();
  const dbPath = join(tmpdir(), `cairn-review-stop-${id}.db`);
  const home = join(tmpdir(), `cairn-review-home-${id}`);
  const transcriptPath = join(tmpdir(), `cairn-review-stop-${id}.jsonl`);
  writeFileSync(transcriptPath, JSON.stringify({
    type: "tool.execution_start",
    timestamp: 20,
    data: { toolCallId: "review-2", toolName: "cairn-skill_review", arguments: { id: "skill-2" } },
  }) + "\n" + JSON.stringify({
    type: "tool.execution_complete",
    timestamp: 21,
    data: { toolCallId: "review-2", success: true },
  }));
  const hook = join(import.meta.dir, "..", "src", "hosts", "copilot-cli", "hook.ts");
  const env = { ...process.env, USERPROFILE: home, HOME: home, CAIRN_DB_PATH: dbPath, CAIRN_MAX_LEARNERS: "0", CAIRN_SKILLS: "1" };
  const invoke = (mode: string, payload: object) => spawnSync(process.execPath, [hook, mode], { input: JSON.stringify(payload), env });

  expect(invoke("post-tool", { sessionId: "session-2", toolName: "cairn-brain_search", toolArgs: {} }).status).toBe(0);
  expect(invoke("post-tool", { sessionId: "session-2", toolName: "cairn-skill_review", toolArgs: { id: "skill-2" }, transcriptPath }).status).toBe(0);
  const stop = invoke("agent-stop", { sessionId: "session-2" });
  expect(stop.status).toBe(0);
  expect(stop.stdout.toString()).toBe("{}");
});

test("stop nudge cap resets for the next genuine user turn", () => {
  const id = randomUUID();
  const home = join(tmpdir(), `cairn-stop-cap-home-${id}`);
  const hook = join(import.meta.dir, "..", "src", "hosts", "copilot-cli", "hook.ts");
  const env = { ...process.env, USERPROFILE: home, HOME: home, CAIRN_SKILLS: "0" };
  const invoke = (mode: string, payload: object = { sessionId: "session-cap" }) =>
    spawnSync(process.execPath, [hook, mode], { input: JSON.stringify(payload), env });

  expect(invoke("user-prompt", { sessionId: "session-cap", prompt: "first" }).status).toBe(0);
  expect(invoke("agent-stop").stdout.toString()).toContain('"decision":"block"');
  expect(invoke("user-prompt", { sessionId: "session-cap", prompt: "continuation-1" }).status).toBe(0);
  expect(invoke("agent-stop").stdout.toString()).toContain('"decision":"block"');
  expect(invoke("user-prompt", { sessionId: "session-cap", prompt: "continuation-2" }).status).toBe(0);
  expect(invoke("agent-stop").stdout.toString()).toBe("{}");

  expect(invoke("user-prompt", { sessionId: "session-cap", prompt: "second" }).status).toBe(0);
  expect(invoke("agent-stop").stdout.toString()).toContain('"decision":"block"');
});
