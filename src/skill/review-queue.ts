import { Database } from "bun:sqlite";
import { mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "../core/config";

export type ReviewJobStatus = "pending" | "running" | "completed" | "failed";

export interface ReviewJob {
  id: string;
  sessionId: string;
  skillId: string;
  transcriptPath: string;
  backend: string;
  status: ReviewJobStatus;
  attempts: number;
  error: string;
  createdTs: number;
  updatedTs: number;
}

export interface EnqueueReview {
  id: string;
  sessionId?: string;
  skillId: string;
  transcriptPath: string;
  backend: string;
  now?: number;
}

const MAX_ATTEMPTS = () => Number(process.env.CAIRN_REVIEW_MAX_ATTEMPTS || "3");
const STALE_MS = () => Number(process.env.CAIRN_REVIEW_STALE_MS || String(6 * 60 * 1000));
export const reviewHeartbeatMs = (): number => Math.max(10, Math.floor(STALE_MS() / 3));

function openQueue(): Database {
  mkdirSync(dirname(config.dbPath), { recursive: true });
  const d = new Database(config.dbPath);
  d.run("PRAGMA busy_timeout = 5000");
  d.run(`CREATE TABLE IF NOT EXISTS review_jobs (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL DEFAULT '',
    skill_id TEXT NOT NULL,
    transcript_path TEXT NOT NULL,
    backend TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0,
    error TEXT NOT NULL DEFAULT '',
    created_ts INTEGER NOT NULL,
    updated_ts INTEGER NOT NULL
  )`);
  d.run("CREATE INDEX IF NOT EXISTS review_jobs_status_created ON review_jobs (status, created_ts)");
  return d;
}

const selectCols =
  "id, session_id AS sessionId, skill_id AS skillId, transcript_path AS transcriptPath, backend, status, attempts, error, created_ts AS createdTs, updated_ts AS updatedTs";

function recoverStale(d: Database, now: number): void {
  const max = MAX_ATTEMPTS();
  d.run(
    `UPDATE review_jobs
       SET status = CASE WHEN attempts >= ? THEN 'failed' ELSE 'pending' END,
           error = 'worker stopped before completing',
           updated_ts = ?
     WHERE status = 'running' AND updated_ts < ?`,
    [max, now, now - STALE_MS()]
  );
}

export function enqueueReview(input: EnqueueReview): { accepted: boolean; created: boolean; job?: ReviewJob } {
  if (!input.id.trim() || !input.skillId.trim() || !input.transcriptPath.trim()) return { accepted: false, created: false };
  const now = input.now ?? Date.now();
  const d = openQueue();
  try {
    const inserted = d.run(
      `INSERT INTO review_jobs (id, session_id, skill_id, transcript_path, backend, status, attempts, error, created_ts, updated_ts)
       VALUES (?, ?, ?, ?, ?, 'pending', 0, '', ?, ?)
       ON CONFLICT(id) DO NOTHING`,
      [input.id, input.sessionId ?? "", input.skillId, input.transcriptPath, input.backend, now, now]
    );
    const job = d.query(`SELECT ${selectCols} FROM review_jobs WHERE id = ?`).get(input.id) as ReviewJob | undefined;
    return { accepted: Boolean(job), created: inserted.changes > 0, job };
  } finally {
    d.close();
  }
}

export function claimReviewJobs(limit: number): ReviewJob[] {
  if (limit <= 0) return [];
  const d = openQueue();
  const now = Date.now();
  try {
    d.run("BEGIN IMMEDIATE");
    recoverStale(d, now);
    const running = (d.query("SELECT COUNT(*) AS count FROM review_jobs WHERE status = 'running'").get() as { count: number }).count;
    const available = Math.max(0, limit - running);
    if (available === 0) {
      d.run("COMMIT");
      return [];
    }
    const rows = d
      .query(`SELECT ${selectCols} FROM review_jobs WHERE status = 'pending' AND attempts < ? ORDER BY created_ts, id LIMIT ?`)
      .all(MAX_ATTEMPTS(), available) as ReviewJob[];
    const claimed: ReviewJob[] = [];
    for (const row of rows) {
      const r = d.run(
        "UPDATE review_jobs SET status = 'running', attempts = attempts + 1, error = '', updated_ts = ? WHERE id = ? AND status = 'pending'",
        [now, row.id]
      );
      if (r.changes > 0) claimed.push({ ...row, status: "running", attempts: row.attempts + 1, error: "", updatedTs: now });
    }
    d.run("COMMIT");
    return claimed;
  } catch (error) {
    try { d.run("ROLLBACK"); } catch { /* no transaction */ }
    throw error;
  } finally {
    d.close();
  }
}

export function completeReviewJob(id: string, attempt: number): boolean {
  const d = openQueue();
  try {
    return d.run(
      "UPDATE review_jobs SET status = 'completed', error = '', updated_ts = ? WHERE id = ? AND status = 'running' AND attempts = ?",
      [Date.now(), id, attempt]
    ).changes > 0;
  } finally {
    d.close();
  }
}

export function heartbeatReviewJob(id: string, attempt: number, now = Date.now()): boolean {
  const d = openQueue();
  try {
    return d.run(
      "UPDATE review_jobs SET updated_ts = ? WHERE id = ? AND status = 'running' AND attempts = ?",
      [now, id, attempt]
    ).changes > 0;
  } finally {
    d.close();
  }
}

export function failReviewJob(id: string, error: string, attempt: number): ReviewJobStatus {
  const d = openQueue();
  const now = Date.now();
  try {
    const row = d.query("SELECT status, attempts FROM review_jobs WHERE id = ?").get(id) as
      { status: ReviewJobStatus; attempts: number } | undefined;
    if (!row) return "failed";
    if (row.status !== "running" || row.attempts !== attempt) return row.status;
    const status: ReviewJobStatus = row.attempts >= MAX_ATTEMPTS() ? "failed" : "pending";
    d.run(
      "UPDATE review_jobs SET status = ?, error = ?, updated_ts = ? WHERE id = ? AND status = 'running' AND attempts = ?",
      [status, error.slice(0, 1000), now, id, attempt]
    );
    return status;
  } finally {
    d.close();
  }
}

export function listReviewJobs(limit = 100): ReviewJob[] {
  const d = openQueue();
  try {
    return d.query(`SELECT ${selectCols} FROM review_jobs ORDER BY created_ts DESC LIMIT ?`).all(limit) as ReviewJob[];
  } finally {
    d.close();
  }
}

export function clearReviewJobs(): void {
  const d = openQueue();
  try { d.run("DELETE FROM review_jobs"); } finally { d.close(); }
}

export function transcriptReviewKey(transcriptPath: string, skillId: string, sessionId = ""): string {
  try {
    const s = statSync(transcriptPath);
    return `${sessionId}:${skillId}:${s.size}:${Math.trunc(s.mtimeMs)}`;
  } catch {
    return `${sessionId}:${skillId}:${transcriptPath}`;
  }
}

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const isReviewTool = (name: string): boolean => name.endsWith("skill_review") || name.includes("skill_review");

export function latestCopilotReview(
  transcriptPath: string,
  sessionId: string,
  options: { skillId?: string; agentId?: string; subagentOnly?: boolean } = {}
): { id: string; skillId: string } | null {
  let lines: string[];
  try { lines = readFileSync(transcriptPath, "utf8").split("\n").filter(Boolean); } catch { return null; }
  const completed = new Set<string>();
  for (let i = lines.length - 1; i >= 0; i--) {
    let event: {
      type?: unknown;
      agentId?: unknown;
      timestamp?: unknown;
      data?: { toolCallId?: unknown; toolName?: unknown; arguments?: unknown; success?: unknown };
    };
    try { event = JSON.parse(lines[i]!); } catch { continue; }
    const toolCallId = str(event.data?.toolCallId);
    if (event.type === "tool.execution_complete") {
      if (toolCallId && event.data?.success === true) completed.add(toolCallId);
      continue;
    }
    if (event.type !== "tool.execution_start" || !isReviewTool(str(event.data?.toolName))) continue;
    if (!toolCallId || !completed.has(toolCallId)) continue;
    const agentId = str(event.agentId);
    if (options.agentId && agentId !== options.agentId) continue;
    if (options.subagentOnly && !agentId) continue;
    let args: { id?: unknown } = {};
    try {
      const raw = event.data?.arguments;
      args = typeof raw === "string" ? JSON.parse(raw) : (raw ?? {}) as { id?: unknown };
    } catch { continue; }
    const skillId = str(args.id);
    if (!skillId || (options.skillId && skillId !== options.skillId)) continue;
    const eventId = typeof event.timestamp === "number" ? event.timestamp : i;
    return { id: `${sessionId}:${agentId || "main"}:${eventId}:${i}:${skillId}`, skillId };
  }
  return null;
}
