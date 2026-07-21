import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "../core/config";

export interface ReviewDeclaration {
  skillId: string;
  eventId: string;
}

export interface LifecycleState {
  turnSeq: number;
  brainUsed: boolean;
  skillUsed: boolean;
  pendingReviewIds: string[];
  pendingReviews: ReviewDeclaration[];
  stopNudges: number;
  reviewNudges: number;
  stopBlocked: boolean;
  reminded: boolean;
  completionNudged: boolean;
  cairnToolObserved: boolean;
}

const fresh = (): LifecycleState => ({
  turnSeq: 0,
  brainUsed: false,
  skillUsed: false,
  pendingReviewIds: [],
  pendingReviews: [],
  stopNudges: 0,
  reviewNudges: 0,
  stopBlocked: false,
  reminded: false,
  completionNudged: false,
  cairnToolObserved: false,
});

let connection: Database | null = null;

function database(): Database {
  if (connection) return connection;
  mkdirSync(dirname(config.dbPath), { recursive: true });
  const d = new Database(config.dbPath);
  d.run("PRAGMA busy_timeout = 5000");
  d.run(`CREATE TABLE IF NOT EXISTS lifecycle_turns (
    scope TEXT PRIMARY KEY,
    turn_seq INTEGER NOT NULL DEFAULT 0,
    brain_used INTEGER NOT NULL DEFAULT 0,
    skill_used INTEGER NOT NULL DEFAULT 0,
    pending_review_ids TEXT NOT NULL DEFAULT '[]',
    pending_reviews TEXT NOT NULL DEFAULT '[]',
    stop_nudges INTEGER NOT NULL DEFAULT 0,
    review_nudges INTEGER NOT NULL DEFAULT 0,
    stop_blocked INTEGER NOT NULL DEFAULT 0,
    reminded INTEGER NOT NULL DEFAULT 0,
    completion_nudged INTEGER NOT NULL DEFAULT 0,
    cairn_tool_observed INTEGER NOT NULL DEFAULT 0,
    updated_ts INTEGER NOT NULL
  )`);
  const columns = d.query("PRAGMA table_info(lifecycle_turns)").all() as { name: string }[];
  if (!columns.some((column) => column.name === "completion_nudged")) {
    d.run("ALTER TABLE lifecycle_turns ADD COLUMN completion_nudged INTEGER NOT NULL DEFAULT 0");
  }
  if (!columns.some((column) => column.name === "cairn_tool_observed")) {
    d.run("ALTER TABLE lifecycle_turns ADD COLUMN cairn_tool_observed INTEGER NOT NULL DEFAULT 0");
  }
  d.run(`CREATE TABLE IF NOT EXISTS lifecycle_delegations (
    tool_call_id TEXT PRIMARY KEY,
    parent_scope TEXT NOT NULL,
    skill_ids TEXT NOT NULL,
    child_scope TEXT NOT NULL DEFAULT '',
    created_ts INTEGER NOT NULL,
    claimed_ts INTEGER NOT NULL DEFAULT 0
  )`);
  connection = d;
  return d;
}

const parse = <T>(value: unknown, fallback: T): T => {
  try { return typeof value === "string" ? JSON.parse(value) as T : fallback; }
  catch { return fallback; }
};

function fromRow(row: Record<string, unknown> | null | undefined): LifecycleState {
  if (!row) return fresh();
  return {
    turnSeq: Number(row.turn_seq || 0),
    brainUsed: Boolean(row.brain_used),
    skillUsed: Boolean(row.skill_used),
    pendingReviewIds: parse(row.pending_review_ids, []),
    pendingReviews: parse(row.pending_reviews, []),
    stopNudges: Number(row.stop_nudges || 0),
    reviewNudges: Number(row.review_nudges || 0),
    stopBlocked: Boolean(row.stop_blocked),
    reminded: Boolean(row.reminded),
    completionNudged: Boolean(row.completion_nudged),
    cairnToolObserved: Boolean(row.cairn_tool_observed),
  };
}

function save(d: Database, scope: string, state: LifecycleState): void {
  d.query(`INSERT INTO lifecycle_turns (
    scope, turn_seq, brain_used, skill_used, pending_review_ids, pending_reviews,
    stop_nudges, review_nudges, stop_blocked, reminded, completion_nudged, cairn_tool_observed, updated_ts
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(scope) DO UPDATE SET
    turn_seq=excluded.turn_seq, brain_used=excluded.brain_used, skill_used=excluded.skill_used,
    pending_review_ids=excluded.pending_review_ids, pending_reviews=excluded.pending_reviews,
    stop_nudges=excluded.stop_nudges, review_nudges=excluded.review_nudges,
    stop_blocked=excluded.stop_blocked, reminded=excluded.reminded,
    completion_nudged=excluded.completion_nudged,
    cairn_tool_observed=excluded.cairn_tool_observed, updated_ts=excluded.updated_ts`)
    .run(
      scope, state.turnSeq, Number(state.brainUsed), Number(state.skillUsed),
      JSON.stringify(state.pendingReviewIds), JSON.stringify(state.pendingReviews),
      state.stopNudges, state.reviewNudges, Number(state.stopBlocked), Number(state.reminded),
      Number(state.completionNudged), Number(state.cairnToolObserved), Date.now()
    );
}

export const lifecycleScope = (host: string, sessionId: string, agentId = ""): string =>
  `${host}:${sessionId || "default"}${agentId ? `:${agentId}` : ""}`;

export function readLifecycle(scope: string): LifecycleState {
  const row = database().query("SELECT * FROM lifecycle_turns WHERE scope = ?").get(scope) as Record<string, unknown> | null;
  return fromRow(row);
}

export function updateLifecycle(scope: string, update: (state: LifecycleState) => LifecycleState): LifecycleState {
  const d = database();
  d.run("BEGIN IMMEDIATE");
  try {
    const row = d.query("SELECT * FROM lifecycle_turns WHERE scope = ?").get(scope) as Record<string, unknown> | null;
    const next = update(fromRow(row));
    save(d, scope, next);
    d.run("COMMIT");
    return next;
  } catch (error) {
    try { d.run("ROLLBACK"); } catch { /* no transaction */ }
    throw error;
  }
}

export function resetLifecycle(
  scope: string,
  initial: Partial<LifecycleState> = {},
  preserveBlockedNudges = false
): LifecycleState {
  return updateLifecycle(scope, (previous) => ({
    ...fresh(),
    ...initial,
    turnSeq: previous.turnSeq + 1,
    stopNudges: preserveBlockedNudges && previous.stopBlocked ? previous.stopNudges : initial.stopNudges ?? 0,
  }));
}

export function registerDelegation(parentScope: string, toolCallId: string, skillIds: string[]): boolean {
  const ids = [...new Set(skillIds.filter(Boolean))];
  if (!toolCallId || !ids.length) return false;
  const d = database();
  d.query("DELETE FROM lifecycle_delegations WHERE created_ts < ?").run(Date.now() - 7 * 24 * 60 * 60 * 1000);
  d.query(`INSERT INTO lifecycle_delegations (tool_call_id, parent_scope, skill_ids, created_ts)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(tool_call_id) DO UPDATE SET
      parent_scope=excluded.parent_scope, skill_ids=excluded.skill_ids, created_ts=excluded.created_ts`)
    .run(toolCallId, parentScope, JSON.stringify(ids), Date.now());
  return true;
}

export function releaseDelegation(toolCallId: string): void {
  if (!toolCallId) return;
  database().query("DELETE FROM lifecycle_delegations WHERE tool_call_id = ?").run(toolCallId);
}

export function claimDelegation(toolCallId: string, childScope: string): string[] {
  if (!toolCallId || !childScope) return [];
  const d = database();
  d.run("BEGIN IMMEDIATE");
  try {
    const row = d.query("SELECT skill_ids, child_scope FROM lifecycle_delegations WHERE tool_call_id = ?")
      .get(toolCallId) as { skill_ids?: string; child_scope?: string } | null;
    if (!row || (row.child_scope && row.child_scope !== childScope)) {
      d.run("COMMIT");
      return [];
    }
    d.query("UPDATE lifecycle_delegations SET child_scope = ?, claimed_ts = ? WHERE tool_call_id = ?")
      .run(childScope, Date.now(), toolCallId);
    d.run("COMMIT");
    return parse(row.skill_ids, []);
  } catch (error) {
    try { d.run("ROLLBACK"); } catch { /* no transaction */ }
    throw error;
  }
}

export function clearLifecycleForTests(): void {
  const d = database();
  d.run("DELETE FROM lifecycle_turns");
  d.run("DELETE FROM lifecycle_delegations");
}
