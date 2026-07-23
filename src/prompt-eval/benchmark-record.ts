import { Database } from "bun:sqlite";
import { writeFileSync } from "node:fs";
import { estimatedTokens } from "../core/telemetry";

export interface BenchmarkRunStart {
  sessionId: string;
  host: "copilot" | "claude";
  caseId: string;
  trial: number;
  promptTokens: number;
}

export function initializeBenchmarkDatabase(
  path: string,
  name: string,
  promptHash: string,
): void {
  const db = new Database(path);
  try {
    db.run(`CREATE TABLE IF NOT EXISTS prompt_benchmark_meta(
      isolated INTEGER NOT NULL,
      benchmark_name TEXT NOT NULL,
      prompt_hash TEXT NOT NULL
    )`);
    db.run("DELETE FROM prompt_benchmark_meta");
    db.query("INSERT INTO prompt_benchmark_meta VALUES (1,?,?)").run(name, promptHash);
    db.run(`CREATE TABLE IF NOT EXISTS prompt_benchmark_runs(
      session_id TEXT PRIMARY KEY,
      host TEXT NOT NULL,
      case_id TEXT NOT NULL,
      trial INTEGER NOT NULL,
      started_ts INTEGER NOT NULL DEFAULT 0,
      prompt_tokens INTEGER NOT NULL,
      context_tokens INTEGER NOT NULL DEFAULT 0,
      completed INTEGER NOT NULL DEFAULT 0,
      workflow_passed INTEGER NOT NULL DEFAULT 0,
      task_assertion_set TEXT NOT NULL DEFAULT '',
      task_assertions_passed INTEGER NOT NULL DEFAULT 0,
      task_assertions_total INTEGER NOT NULL DEFAULT 0,
      tool_failures INTEGER NOT NULL DEFAULT 0,
      stop_nudges INTEGER NOT NULL DEFAULT 0,
      unexpected_events INTEGER NOT NULL DEFAULT 0
    )`);
    const columns = db.query("PRAGMA table_info(prompt_benchmark_runs)")
     .all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "context_tokens")) {
     db.run("ALTER TABLE prompt_benchmark_runs ADD COLUMN context_tokens INTEGER NOT NULL DEFAULT 0");
    }
    if (!columns.some((column) => column.name === "started_ts")) {
     db.run("ALTER TABLE prompt_benchmark_runs ADD COLUMN started_ts INTEGER NOT NULL DEFAULT 0");
    }
    db.run(`CREATE TABLE IF NOT EXISTS prompt_benchmark_events(
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      args_json TEXT NOT NULL,
      result_json TEXT NOT NULL,
      success INTEGER NOT NULL
    )`);
  } finally {
    db.close();
  }
}

export function beginBenchmarkRun(path: string, run: BenchmarkRunStart): void {
  const db = new Database(path);
  try {
    db.query(`INSERT INTO prompt_benchmark_runs(
      session_id,host,case_id,trial,started_ts,prompt_tokens,context_tokens
    ) VALUES (?,?,?,?,?,?,?)`).run(
      run.sessionId,
      run.host,
      run.caseId,
      run.trial,
      Date.now(),
      run.promptTokens,
      run.promptTokens,
    );
  } finally {
    db.close();
  }
}

export function recordBenchmarkContext(text: string): void {
  const path = process.env.CAIRN_DB_PATH;
  const sessionId = process.env.CAIRN_PROMPT_BENCHMARK_SESSION;
  if (!path || !sessionId || !text) return;
  try {
    const db = new Database(path);
    try {
      db.query(`UPDATE prompt_benchmark_runs
        SET context_tokens=context_tokens+?
        WHERE session_id=?`).run(estimatedTokens(text.length), sessionId);
    } finally {
      db.close();
    }
  } catch { /* benchmark recording never breaks a hook */ }
}

export function finishBenchmarkRun(path: string, input: {
  sessionId: string;
  completed: boolean;
  workflowPassed: boolean;
  assertionSet: string;
  assertionsPassed: number;
  assertionsTotal: number;
}): void {
  const db = new Database(path);
  try {
    db.query(`UPDATE prompt_benchmark_runs SET
      completed=?,workflow_passed=?,task_assertion_set=?,
      task_assertions_passed=?,task_assertions_total=?
      WHERE session_id=?`).run(
      Number(input.completed),
      Number(input.workflowPassed),
      input.assertionSet,
      input.assertionsPassed,
      input.assertionsTotal,
      input.sessionId,
    );
  } finally {
    db.close();
  }
}

export function finalizeBenchmarkContext(path: string, sessionId: string): void {
  const db = new Database(path);
  try {
    const run = db.query(`SELECT started_ts FROM prompt_benchmark_runs WHERE session_id=?`)
      .get(sessionId) as { started_ts: number } | null;
    if (!run) return;
    const measured = db.query(`SELECT COALESCE(SUM(output_tokens),0) AS tokens
      FROM telemetry_events WHERE kind='tool' AND run_class='benchmark' AND ts>=?`)
      .get(run.started_ts) as { tokens: number };
    if (measured.tokens <= 0) return;
    db.query(`UPDATE prompt_benchmark_runs
      SET context_tokens=prompt_tokens+? WHERE session_id=?`)
      .run(measured.tokens, sessionId);
  } finally {
    db.close();
  }
}

export function recordBenchmarkTool(input: {
  toolName: string;
  args: unknown;
  result: unknown;
  success: boolean;
}): void {
  const path = process.env.CAIRN_DB_PATH;
  const sessionId = process.env.CAIRN_PROMPT_BENCHMARK_SESSION;
  if (!path || !sessionId) return;
  try {
    const db = new Database(path);
    try {
      db.query(`INSERT INTO prompt_benchmark_events(
        session_id,tool_name,args_json,result_json,success
      ) VALUES (?,?,?,?,?)`).run(
        sessionId,
        input.toolName,
        JSON.stringify(input.args ?? null),
        JSON.stringify(input.result ?? null),
        Number(input.success),
      );
      db.query(`UPDATE prompt_benchmark_runs
        SET context_tokens=context_tokens+?
        WHERE session_id=?`).run(
        estimatedTokens(JSON.stringify(input.result ?? null).length),
        sessionId,
      );
      if (!input.success) {
        db.query(`UPDATE prompt_benchmark_runs SET tool_failures=tool_failures+1
          WHERE session_id=?`).run(sessionId);
      }
    } finally {
      db.close();
    }
  } catch { /* benchmark recording never breaks a tool response */ }
}

export function submitBenchmarkResult(result: unknown): { ok: true } {
  const path = process.env.CAIRN_PROMPT_BENCHMARK_RESULT;
  if (!path) throw new Error("benchmark result path is unavailable");
  writeFileSync(path, JSON.stringify(result));
  return { ok: true };
}

export function registerBenchmarkProcess(): void {
  const path = process.env.CAIRN_PROMPT_BENCHMARK_PID_PATH;
  if (path) writeFileSync(path, String(process.pid));
}
