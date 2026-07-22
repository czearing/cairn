import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { qualityRunId } from "../src/core/quality-record";

const root = join(import.meta.dir, "..");

function invoke(path: string, args: string[], payload: object, env: Record<string, string>) {
  return spawnSync(process.execPath, [path, ...args], {
    cwd: root,
    input: JSON.stringify(payload),
    env: { ...process.env, ...env },
  });
}

test("Copilot hooks correlate returned brain nodes with later use and completion", () => {
  const dbPath = join(tmpdir(), `cairn-quality-copilot-${randomUUID()}.db`);
  const sessionId = `copilot-quality-${randomUUID()}`;
  const hook = join(root, "src", "hosts", "copilot-cli", "hook.ts");
  const env = { CAIRN_DB_PATH: dbPath, CAIRN_USAGE: "1", CAIRN_SKILLS: "1" };
  expect(invoke(hook, ["user-prompt"], { sessionId, prompt: "Fix it." }, env).status).toBe(0);
  let toolCall = 0;
  const post = (toolName: string, toolArgs: object, toolResult: unknown) =>
    invoke(hook, ["post-tool"], {
      sessionId, toolCallId: `call-${++toolCall}`, toolName, toolArgs, toolResult,
    }, env);
  expect(post("cairn-skill_select", { ids: ["software"] }, { ok: true }).status).toBe(0);
  expect(post("cairn-brain_search", { query: "fix" }, [{ id: "node-a", text: "answer" }]).status).toBe(0);
  expect(post("cairn-brain_mutate", { id: "node-a", answer: "done" }, { id: "node-a" }).status).toBe(0);
  expect(invoke(hook, ["agent-stop"], { sessionId }, env).status).toBe(0);
  expect(invoke(hook, ["agent-stop"], { sessionId }, env).status).toBe(0);

  const db = new Database(dbPath, { readonly: true });
  const runId = qualityRunId({ host: "copilot", sessionId, turnSeq: 1 });
  const run = db.query("SELECT completed,workflow_passed FROM quality_runs WHERE run_id=?").get(runId);
  const kinds = db.query("SELECT kind FROM quality_events WHERE run_id=? ORDER BY kind").all(runId);
  db.close();
  expect(run).toEqual({ completed: 1, workflow_passed: 1 });
  expect(kinds).toContainEqual({ kind: "brain_returned" });
  expect(kinds).toContainEqual({ kind: "brain_mutated" });
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
  const run = db.query("SELECT completed FROM quality_runs WHERE host='claude'").get();
  const returned = db.query("SELECT COUNT(*) AS count FROM quality_events WHERE kind='brain_returned'").get();
  db.close();
  expect(run).toEqual({ completed: 1 });
  expect(returned).toEqual({ count: 1 });
});
