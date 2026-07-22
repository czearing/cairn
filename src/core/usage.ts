import { createHash } from "node:crypto";
import { usageTelemetryEnabled } from "./config";
import { localEventsDatabase } from "./host-events";

export interface UsageEvent {
  eventKind: "context" | "tool";
  source: string;
  host?: string;
  sessionId?: string;
  turnSeq?: number;
  toolName?: string;
  inputChars?: number;
  outputChars?: number;
  contextChars?: number;
  durationMs?: number;
  itemCount?: number;
  success?: boolean;
  eventKey?: string;
  ts?: number;
}

export interface UsageGroup {
  eventKind: string;
  source: string;
  host: string;
  toolName: string;
  events: number;
  estimatedTokens: number;
  minimumTokens: number;
  maximumTokens: number;
  inputChars: number;
  outputChars: number;
  contextChars: number;
  averageDurationMs: number;
  failures: number;
}

export interface UsageImpact {
  prompts: number;
  sessions: number;
  currentPromptTokens: number;
  measuredTokensPerPrompt: number;
  contextTokens: number;
  toolTokens: number;
  contextPercent: number;
  toolPercent: number;
  firstEventTs: number;
  lastEventTs: number;
  latestContextTs: number;
  latestToolTs: number;
  toolTelemetryLagMs: number;
}

let schemaReady = false;

const chars = (value: number | undefined): number =>
  Number.isFinite(value) ? Math.max(0, Math.round(value!)) : 0;

const sessionHash = (sessionId = ""): string =>
  sessionId
    ? createHash("sha256").update(sessionId).digest("hex").slice(0, 16)
    : "";

const eventKeyHash = (eventKey = ""): string | null =>
  eventKey
    ? createHash("sha256").update(eventKey).digest("hex")
    : null;

function database() {
  const d = localEventsDatabase();
  if (schemaReady) return d;
  d.run(`CREATE TABLE IF NOT EXISTS usage_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_key TEXT UNIQUE,
    ts INTEGER NOT NULL,
    event_kind TEXT NOT NULL,
    source TEXT NOT NULL,
    host TEXT NOT NULL DEFAULT '',
    session_hash TEXT NOT NULL DEFAULT '',
    turn_seq INTEGER NOT NULL DEFAULT 0,
    tool_name TEXT NOT NULL DEFAULT '',
    input_chars INTEGER NOT NULL DEFAULT 0,
    output_chars INTEGER NOT NULL DEFAULT 0,
    context_chars INTEGER NOT NULL DEFAULT 0,
    estimated_tokens INTEGER NOT NULL DEFAULT 0,
    duration_ms INTEGER NOT NULL DEFAULT 0,
    item_count INTEGER NOT NULL DEFAULT 0,
    success INTEGER NOT NULL DEFAULT 1
  )`);
  d.run("CREATE INDEX IF NOT EXISTS usage_events_ts ON usage_events(ts)");
  d.run("CREATE INDEX IF NOT EXISTS usage_events_source ON usage_events(event_kind,source,ts)");
  d.run("CREATE INDEX IF NOT EXISTS usage_events_session ON usage_events(session_hash,turn_seq,ts)");
  const retentionDays = Math.max(1, Number(process.env.CAIRN_USAGE_RETENTION_DAYS || "30"));
  d.query("DELETE FROM usage_events WHERE ts < ?").run(Date.now() - retentionDays * 86_400_000);
  schemaReady = true;
  return d;
}

export function estimatedTokens(totalChars: number): number {
  return Math.ceil(chars(totalChars) / 4);
}

export function recordUsage(event: UsageEvent): boolean {
  if (!usageTelemetryEnabled()) return false;
  try {
    const input = chars(event.inputChars);
    const output = chars(event.outputChars);
    const context = chars(event.contextChars);
    database().query(`INSERT INTO usage_events(
      event_key,ts,event_kind,source,host,session_hash,turn_seq,tool_name,
      input_chars,output_chars,context_chars,estimated_tokens,duration_ms,item_count,success
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(event_key) DO NOTHING`).run(
      eventKeyHash(event.eventKey),
      event.ts ?? Date.now(),
      event.eventKind,
      event.source,
      event.host ?? "",
      sessionHash(event.sessionId),
      chars(event.turnSeq),
      event.toolName ?? "",
      input,
      output,
      context,
      estimatedTokens(input + output + context),
      chars(event.durationMs),
      chars(event.itemCount),
      Number(event.success !== false),
    );
    return true;
  } catch {
    return false;
  }
}

export function usageSummary(days = 7): {
  sinceTs: number;
  totals: UsageGroup;
  impact: UsageImpact;
  groups: UsageGroup[];
} {
  const sinceTs = Date.now() - Math.max(1, days) * 86_400_000;
  const metrics = `COUNT(*) AS events,COALESCE(SUM(estimated_tokens),0) AS estimatedTokens,
    COALESCE(MIN(estimated_tokens),0) AS minimumTokens,
    COALESCE(MAX(estimated_tokens),0) AS maximumTokens,
    COALESCE(SUM(input_chars),0) AS inputChars,COALESCE(SUM(output_chars),0) AS outputChars,
    COALESCE(SUM(context_chars),0) AS contextChars,
    ROUND(COALESCE(AVG(duration_ms),0),1) AS averageDurationMs,
    COALESCE(SUM(CASE WHEN success=0 THEN 1 ELSE 0 END),0) AS failures`;
  const d = database();
  const totalMetrics = d.query(`SELECT ${metrics} FROM usage_events WHERE ts >= ?`)
    .get(sinceTs) as Omit<UsageGroup, "eventKind" | "source" | "host" | "toolName">;
  const totals: UsageGroup = { eventKind: "", source: "", host: "", toolName: "", ...totalMetrics };
  const groups = d.query(`SELECT event_kind AS eventKind,source,host,tool_name AS toolName,${metrics}
    FROM usage_events WHERE ts >= ?
    GROUP BY event_kind,source,host,tool_name
    ORDER BY estimatedTokens DESC,events DESC`).all(sinceTs) as UsageGroup[];
  const coverage = d.query(`SELECT
      COUNT(DISTINCT CASE WHEN session_hash != '' THEN session_hash END) AS sessions,
      COALESCE(MIN(ts),0) AS firstEventTs,COALESCE(MAX(ts),0) AS lastEventTs,
      COALESCE(MAX(CASE WHEN event_kind='context' THEN ts ELSE 0 END),0) AS latestContextTs,
      COALESCE(MAX(CASE WHEN event_kind='tool' THEN ts ELSE 0 END),0) AS latestToolTs
    FROM usage_events WHERE ts >= ?`).get(sinceTs) as {
      sessions: number;
      firstEventTs: number;
      lastEventTs: number;
      latestContextTs: number;
      latestToolTs: number;
    };
  const latestPrompt = d.query(`SELECT estimated_tokens AS tokens FROM usage_events
    WHERE ts >= ? AND event_kind='context' AND source='user-prompt'
    ORDER BY ts DESC LIMIT 1`).get(sinceTs) as { tokens: number } | null;
  const contextTokens = groups
    .filter((group) => group.eventKind === "context")
    .reduce((total, group) => total + group.estimatedTokens, 0);
  const toolTokens = groups
    .filter((group) => group.eventKind === "tool")
    .reduce((total, group) => total + group.estimatedTokens, 0);
  const prompts = groups.find((group) =>
    group.eventKind === "context" && group.source === "user-prompt"
  )?.events ?? 0;
  const totalTokens = totals.estimatedTokens;
  const impact: UsageImpact = {
    ...coverage,
    prompts,
    currentPromptTokens: latestPrompt?.tokens ?? 0,
    measuredTokensPerPrompt: prompts > 0 ? Math.round(totalTokens / prompts) : 0,
    contextTokens,
    toolTokens,
    contextPercent: totalTokens > 0 ? Math.round(contextTokens * 100 / totalTokens) : 0,
    toolPercent: totalTokens > 0 ? Math.round(toolTokens * 100 / totalTokens) : 0,
    toolTelemetryLagMs: coverage.latestContextTs > coverage.latestToolTs
      ? coverage.latestContextTs - coverage.latestToolTs
      : 0,
  };
  return { sinceTs, totals, impact, groups };
}

export function jsonChars(value: unknown): number {
  try { return JSON.stringify(value).length; }
  catch { return 0; }
}
