import { Database } from "bun:sqlite";
import { config } from "./config";
import { configureSqliteLibrary } from "./sqlite";

export interface LifecycleTurn {
  scope: string;
  turnSeq: number;
  searched: boolean;
  searchedNodeIds: string[];
  createdCount: number;
  answeredCount: number;
  reusedCount: number;
  reusedNodeIds: string[];
  createdNodeIds: string[];
  openCreatedNodeIds: string[];
  rootSynthesized: boolean;
  cairnToolAttempted: boolean;
  cairnToolObserved: boolean;
  cairnVisibilityNudged: boolean;
  executionToolCount: number;
  stopNudges: number;
  stopBlocked: boolean;
  completionNudged: boolean;
}

const defaultState = (scope: string): LifecycleTurn => ({
  scope,
  turnSeq: 0,
  searched: false,
  searchedNodeIds: [],
  createdCount: 0,
  answeredCount: 0,
  reusedCount: 0,
  reusedNodeIds: [],
  createdNodeIds: [],
  openCreatedNodeIds: [],
  rootSynthesized: false,
  cairnToolAttempted: false,
  cairnToolObserved: false,
  cairnVisibilityNudged: false,
  executionToolCount: 0,
  stopNudges: 0,
  stopBlocked: false,
  completionNudged: false,
});

export function isSystemEnvelope(text: string): boolean {
  const trimmed = text.trim();
  return (
    trimmed.startsWith("<system_reminder>") ||
    trimmed.startsWith("<system_notifications>") ||
    trimmed.startsWith("<cairn-internal>") ||
    trimmed.startsWith("<tools_changed_notice>")
  );
}

export function lifecycleScope(host: string, sessionId: string): string {
  return `${host}:${sessionId}`;
}

function ensureLifecycleSchema(db: Database): void {
  db.run(`CREATE TABLE IF NOT EXISTS lifecycle_turns (
    scope TEXT PRIMARY KEY,
    turn_seq INTEGER NOT NULL DEFAULT 0,
    searched INTEGER NOT NULL DEFAULT 0,
    searched_node_ids TEXT NOT NULL DEFAULT '[]',
    created_count INTEGER NOT NULL DEFAULT 0,
    answered_count INTEGER NOT NULL DEFAULT 0,
    reused_count INTEGER NOT NULL DEFAULT 0,
    reused_node_ids TEXT NOT NULL DEFAULT '[]',
    created_node_ids TEXT NOT NULL DEFAULT '[]',
    open_created_node_ids TEXT NOT NULL DEFAULT '[]',
    root_synthesized INTEGER NOT NULL DEFAULT 0,
    cairn_tool_attempted INTEGER NOT NULL DEFAULT 0,
    cairn_tool_observed INTEGER NOT NULL DEFAULT 0,
    cairn_visibility_nudged INTEGER NOT NULL DEFAULT 0,
    execution_tool_count INTEGER NOT NULL DEFAULT 0,
    stop_nudges INTEGER NOT NULL DEFAULT 0,
    stop_blocked INTEGER NOT NULL DEFAULT 0,
    completion_nudged INTEGER NOT NULL DEFAULT 0
  )`);
}

function parseJsonArray(val: unknown): string[] {
  if (typeof val !== "string") return [];
  try {
    const parsed = JSON.parse(val);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

export function readLifecycle(scope: string, dbPath = config.dbPath): LifecycleTurn {
  configureSqliteLibrary();
  const db = new Database(dbPath);
  try {
    ensureLifecycleSchema(db);
    const row = db.query("SELECT * FROM lifecycle_turns WHERE scope = ?").get(scope) as Record<string, unknown> | undefined;
    if (!row) return defaultState(scope);
    return {
      scope,
      turnSeq: Number(row.turn_seq ?? 0),
      searched: Boolean(row.searched),
      searchedNodeIds: parseJsonArray(row.searched_node_ids),
      createdCount: Number(row.created_count ?? 0),
      answeredCount: Number(row.answered_count ?? 0),
      reusedCount: Number(row.reused_count ?? 0),
      reusedNodeIds: parseJsonArray(row.reused_node_ids),
      createdNodeIds: parseJsonArray(row.created_node_ids),
      openCreatedNodeIds: parseJsonArray(row.open_created_node_ids),
      rootSynthesized: Boolean(row.root_synthesized),
      cairnToolAttempted: Boolean(row.cairn_tool_attempted),
      cairnToolObserved: Boolean(row.cairn_tool_observed),
      cairnVisibilityNudged: Boolean(row.cairn_visibility_nudged),
      executionToolCount: Number(row.execution_tool_count ?? 0),
      stopNudges: Number(row.stop_nudges ?? 0),
      stopBlocked: Boolean(row.stop_blocked),
      completionNudged: Boolean(row.completion_nudged),
    };
  } finally {
    db.close();
  }
}

export function updateLifecycle(
  scope: string,
  fn: (state: LifecycleTurn) => LifecycleTurn,
  dbPath = config.dbPath,
): LifecycleTurn {
  configureSqliteLibrary();
  const db = new Database(dbPath);
  try {
    ensureLifecycleSchema(db);
    const current = readLifecycle(scope, dbPath);
    const updated = fn(current);
    db.run(
      `INSERT INTO lifecycle_turns (
        scope, turn_seq, searched, searched_node_ids, created_count, answered_count,
        reused_count, reused_node_ids, created_node_ids, open_created_node_ids,
        root_synthesized, cairn_tool_attempted, cairn_tool_observed, cairn_visibility_nudged,
        execution_tool_count, stop_nudges, stop_blocked, completion_nudged
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(scope) DO UPDATE SET
        turn_seq=excluded.turn_seq,
        searched=excluded.searched,
        searched_node_ids=excluded.searched_node_ids,
        created_count=excluded.created_count,
        answered_count=excluded.answered_count,
        reused_count=excluded.reused_count,
        reused_node_ids=excluded.reused_node_ids,
        created_node_ids=excluded.created_node_ids,
        open_created_node_ids=excluded.open_created_node_ids,
        root_synthesized=excluded.root_synthesized,
        cairn_tool_attempted=excluded.cairn_tool_attempted,
        cairn_tool_observed=excluded.cairn_tool_observed,
        cairn_visibility_nudged=excluded.cairn_visibility_nudged,
        execution_tool_count=excluded.execution_tool_count,
        stop_nudges=excluded.stop_nudges,
        stop_blocked=excluded.stop_blocked,
        completion_nudged=excluded.completion_nudged`,
      [
        scope,
        updated.turnSeq,
        updated.searched ? 1 : 0,
        JSON.stringify(updated.searchedNodeIds),
        updated.createdCount,
        updated.answeredCount,
        updated.reusedCount,
        JSON.stringify(updated.reusedNodeIds),
        JSON.stringify(updated.createdNodeIds),
        JSON.stringify(updated.openCreatedNodeIds),
        updated.rootSynthesized ? 1 : 0,
        updated.cairnToolAttempted ? 1 : 0,
        updated.cairnToolObserved ? 1 : 0,
        updated.cairnVisibilityNudged ? 1 : 0,
        updated.executionToolCount,
        updated.stopNudges,
        updated.stopBlocked ? 1 : 0,
        updated.completionNudged ? 1 : 0,
      ],
    );
    return updated;
  } finally {
    db.close();
  }
}

export function resetLifecycle(scope: string, dbPath = config.dbPath): void {
  updateLifecycle(scope, (s) => ({
    ...defaultState(scope),
    turnSeq: s.turnSeq + 1,
    cairnToolObserved: s.cairnToolObserved,
  }), dbPath);
}
