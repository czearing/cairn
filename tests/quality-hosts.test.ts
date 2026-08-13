import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { telemetryRunId } from "../src/core/telemetry";

const root = join(import.meta.dir, "..");

function invoke(path: string, args: string[], payload: object, env: Record<string, string>) {
  return spawnSync(process.execPath, [path, ...args], {
    cwd: root,
    input: JSON.stringify(payload),
    env: { ...process.env, ...env },
  });
}

function completeCopilotBrain(
  post: (toolName: string, toolArgs: object, toolResult: unknown) => ReturnType<typeof spawnSync>,
  prefix: string,
  dbPath?: string,
): void {
  // The contract gate is unconditional, so a releasable turn also needs a satisfied contract, written
  // beside the database exactly where the `contract` MCP tool puts it.
  if (dbPath) {
    writeFileSync(join(dirname(dbPath), "contract.json"), JSON.stringify({
      criteria: [{ check: `${prefix} is done`, passed: true, failedFirst: false, evidence: "verified" }],
      nudges: 0,
    }));
  }
  const root = `${prefix}-root`;
  const child = `${prefix}-child`;
  const leaf = `${prefix}-leaf`;
  for (const [id, edges] of [
    [root, []],
    [child, [root]],
    [leaf, [child]],
  ] as const) {
    expect(post("cairn-brain_create", {
      text: `How is ${id} resolved?`,
      edges,
    }, { success: true, id }).status).toBe(0);
  }
  for (const id of [leaf, child, root]) {
    expect(post("cairn-brain_mutate", {
      id,
      answer: `Resolved ${id}.`,
      citation: "https://example.com/evidence",
    }, { success: true, id }).status).toBe(0);
  }
}

test("Copilot hooks correlate returned brain nodes with later use and completion", () => {
  const dbPath = join(tmpdir(), `cairn-quality-copilot-${randomUUID()}.db`);
  const sessionId = `copilot-quality-${randomUUID()}`;
  const hook = join(root, "src", "hosts", "copilot-cli", "hook.ts");
  const env = { CAIRN_DB_PATH: dbPath, CAIRN_USAGE: "1", CAIRN_SKILLS: "1" };
  expect(invoke(hook, ["user-prompt"], {
    sessionId,
    prompt: "Fix it.",
    model: "gpt-test",
  }, env).status).toBe(0);
  let toolCall = 0;
  const post = (toolName: string, toolArgs: object, toolResult: unknown) =>
    invoke(hook, ["post-tool"], {
      sessionId, toolCallId: `call-${++toolCall}`, toolName, toolArgs, toolResult,
    }, env);
  expect(post("cairn-skill_select", { ids: ["software"] }, { ok: true }).status).toBe(0);
  expect(post("cairn-brain_search", { query: "fix" }, {
    _meta: {
      cairn: {
        version: "runtime-version",
        releaseFingerprint: "runtime-fingerprint",
      },
    },
    content: [{ text: JSON.stringify([{ id: "node-a", text: "answer", score: 0.9 }]) }],
  }).status).toBe(0);
  expect(post("cairn-brain_mutate", { id: "node-a", answer: "done" }, { id: "node-a" }).status).toBe(0);
  completeCopilotBrain(post, sessionId, dbPath);
  expect(invoke(hook, ["agent-stop"], { sessionId }, env).status).toBe(0);

  const db = new Database(dbPath, { readonly: true });
  const runId = telemetryRunId({ host: "copilot", sessionId, turnSeq: 1 });
  const run = db.query("SELECT completed,workflow_passed,model FROM telemetry_runs WHERE run_id=?").get(runId);
  const kinds = db.query("SELECT kind FROM telemetry_events WHERE run_id=? ORDER BY kind").all(runId);
  const runtime = db.query(`SELECT version,release_fingerprint,
      runtime_version,runtime_release_fingerprint
    FROM telemetry_events WHERE run_id=? AND kind='tool' AND tool_name='brain_search'`).get(runId);
  db.close();
  expect(run).toEqual({ completed: 1, workflow_passed: 1, model: "gpt-test" });
  expect(kinds).toContainEqual({ kind: "brain_returned" });
  expect(kinds).toContainEqual({ kind: "brain_mutated" });
  expect(runtime).toEqual({
    version: "runtime-version",
    release_fingerprint: "runtime-fingerprint",
    runtime_version: "runtime-version",
    runtime_release_fingerprint: "runtime-fingerprint",
  });
});

test("Copilot can retain the completion continuation as an explicit baseline", () => {
  const dbPath = join(tmpdir(), `cairn-completion-baseline-${randomUUID()}.db`);
  const sessionId = `copilot-completion-${randomUUID()}`;
  const hook = join(root, "src", "hosts", "copilot-cli", "hook.ts");
  const env = {
    CAIRN_DB_PATH: dbPath,
    CAIRN_USAGE: "1",
    CAIRN_SKILLS: "1",
    CAIRN_FORCE_COMPLETION_CONTINUATION: "1",
  };
  invoke(hook, ["user-prompt"], { sessionId, prompt: "Fix it." }, env);
  let toolCall = 0;
  const post = (toolName: string, toolArgs: object, toolResult: unknown) =>
    invoke(hook, ["post-tool"], {
      sessionId, toolCallId: `call-${++toolCall}`, toolName, toolArgs, toolResult,
    }, env);
  post("cairn-skill_select", { ids: ["software"] }, { ok: true });
  post("cairn-brain_search", { query: "fix" }, { success: true, content: [] });
  completeCopilotBrain(post, sessionId, dbPath);
  const blocked = invoke(hook, ["agent-stop"], { sessionId }, env);
  expect(JSON.parse(blocked.stdout.toString())).toMatchObject({ decision: "block" });
  invoke(hook, ["agent-stop"], { sessionId }, env);
  const db = new Database(dbPath, { readonly: true });
  expect(db.query(`SELECT COUNT(*) AS count FROM telemetry_events
    WHERE kind='completion_blocked'`).get()).toEqual({ count: 1 });
  db.close();
});

test("Claude records quality evidence even when skills are disabled", () => {
  const dbPath = join(tmpdir(), `cairn-quality-claude-${randomUUID()}.db`);
  const sessionId = `claude-quality-${randomUUID()}`;
  const dispatch = join(root, "src", "hosts", "claude-code", "dispatch.ts");
  const transcriptPath = join(tmpdir(), `cairn-quality-claude-${randomUUID()}.jsonl`);
  writeFileSync(transcriptPath, "");
  const env = { CAIRN_DB_PATH: dbPath, CAIRN_USAGE: "1", CAIRN_SKILLS: "0" };
  const fire = (payload: object) => invoke(dispatch, [], { session_id: sessionId, ...payload }, env);
  expect(fire({ hook_event_name: "UserPromptSubmit", prompt: "Fix it." }).status).toBe(0);
  expect(fire({
    hook_event_name: "PostToolUse", tool_name: "brain_search",
    tool_input: { query: "fix" }, tool_output: [{ id: "node-a", text: "answer" }],
  }).status).toBe(0);
  expect(fire({ hook_event_name: "Stop", stop_hook_active: true, transcript_path: transcriptPath }).status).toBe(0);

  const db = new Database(dbPath, { readonly: true });
  const run = db.query("SELECT completed FROM telemetry_runs WHERE host='claude'").get();
  const returned = db.query("SELECT COUNT(*) AS count FROM telemetry_events WHERE kind='brain_returned'").get();
  db.close();
  expect(run).toEqual({ completed: 1 });
  expect(returned).toEqual({ count: 1 });
});
