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
