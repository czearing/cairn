import { createHash } from "node:crypto";
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "./config";
import { db, type Db } from "./db";
import { HOST_EVENTS_SCHEMA } from "./host-events.schema";

type HostName = "copilot" | "claude";

interface HostEventRow {
  eventKey: string;
  host: HostName;
  hookType: string;
  sessionId: string;
  turnId: string;
  agentId: string;
  toolCallId: string;
  toolName: string;
  eventTimestamp: string;
  rawJson: string;
  recordedTs: number;
}

let connection: Database | null = null;

export function localEventsDatabase(): Database | Db {
  if (process.env.CAIRN_READONLY !== "1") return db();
  if (connection) return connection;
  mkdirSync(dirname(config.dbPath), { recursive: true });
  const d = new Database(config.dbPath);
  d.run("PRAGMA journal_mode = WAL");
  d.run("PRAGMA busy_timeout = 5000");
  d.run("PRAGMA synchronous = NORMAL");
  for (const sql of HOST_EVENTS_SCHEMA) d.run(sql);
  connection = d;
  return d;
}

const text = (value: unknown): string =>
  typeof value === "string" || typeof value === "number" ? String(value) : "";

function fields(host: HostName, payload: Record<string, unknown>): Omit<
  HostEventRow,
  "eventKey" | "host" | "hookType" | "rawJson" | "recordedTs"
> {
  if (host === "claude") {
    return {
      sessionId: text(payload.session_id),
      turnId: text(payload.turn_id),
      agentId: text(payload.agent_id),
      toolCallId: text(payload.tool_use_id),
      toolName: text(payload.tool_name),
      eventTimestamp: text(payload.timestamp),
    };
  }
  const firstCall = Array.isArray(payload.toolCalls) && payload.toolCalls[0]
    && typeof payload.toolCalls[0] === "object"
    ? payload.toolCalls[0] as Record<string, unknown>
    : {};
  return {
    sessionId: text(payload.sessionId ?? payload.session_id),
    turnId: text(payload.turnId ?? payload.turn_id),
    agentId: text(payload.agentId ?? payload.agent_id),
    toolCallId: text(payload.toolCallId ?? payload.tool_call_id ?? firstCall.id),
    toolName: text(payload.toolName ?? payload.tool_name ?? firstCall.name),
    eventTimestamp: text(payload.timestamp),
  };
}

export function recordHostEvent(
  host: HostName,
  hookType: string,
  rawJson: string,
  payload: unknown,
  recordedTs = Date.now()
): string {
  if (!rawJson || !payload || typeof payload !== "object") return "";
  const exact = fields(host, payload as Record<string, unknown>);
  const eventKey = createHash("sha256").update(host).update("\0")
    .update(hookType).update("\0").update(rawJson).digest("hex");
  localEventsDatabase().query(`INSERT INTO host_events(
    event_key,host,hook_type,session_id,turn_id,agent_id,tool_call_id,tool_name,
    event_timestamp,raw_json,recorded_ts
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(event_key) DO NOTHING`)
    .run(
      eventKey, host, hookType, exact.sessionId, exact.turnId, exact.agentId,
      exact.toolCallId, exact.toolName, exact.eventTimestamp, rawJson, recordedTs
    );
  return eventKey;
}

export function hostEvents(host: HostName, sessionId: string): HostEventRow[] {
  return localEventsDatabase().query(`SELECT
    event_key AS eventKey,host,hook_type AS hookType,session_id AS sessionId,
    turn_id AS turnId,agent_id AS agentId,tool_call_id AS toolCallId,
    tool_name AS toolName,event_timestamp AS eventTimestamp,raw_json AS rawJson,
    recorded_ts AS recordedTs
    FROM host_events WHERE host = ? AND session_id = ?
    ORDER BY recorded_ts,event_key`).all(host, sessionId) as HostEventRow[];
}

// Tools this session reported AFTER running but never announced BEFORE running.
//
// Hosts cache their hook configuration when the session starts, so a session that began before a hook
// config change keeps running the OLD one for its entire life and cannot heal itself. That is invisible
// from inside the session: the pre-tool gate simply never fires and everything looks normal. It is
// observable here because every hook fire records an event before any dispatch, so a pre-tool hook that
// the host never invoked leaves a hole rather than a row.
//
// When the gate is installed and live, the host announces every call before running it, so the set of
// tools with post-tool events is a SUBSET of the set with pre-tool events. Any tool outside that subset
// means the host is not calling preToolUse for it. This compares a session against itself and knows no
// tool names, so it reports a real host/config divergence rather than a guess about which tools matter.
export function unannouncedTools(host: HostName, sessionId: string): string[] {
  return (localEventsDatabase().query(`SELECT tool_name AS toolName
    FROM host_events
    WHERE host = ? AND session_id = ? AND tool_name <> ''
    GROUP BY tool_name
    HAVING SUM(CASE WHEN hook_type = 'pre-tool' THEN 1 ELSE 0 END) = 0
       AND SUM(CASE WHEN hook_type = 'post-tool' THEN 1 ELSE 0 END) > 0
    ORDER BY tool_name`).all(host, sessionId) as { toolName: string }[])
    .map((row) => row.toolName);
}
