import { createHash } from "node:crypto";
import { usageTelemetryEnabled } from "./config";
import { releaseVersion, telemetryRunClass } from "./release";
import { usageDatabase } from "./usage-schema";

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
  releaseFingerprint?: string;
  version?: string;
  runClass?: "human" | "benchmark" | "worker";
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
  releaseFingerprint: string;
  version: string;
  runClass: string;
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
  toolTelemetryMissing: boolean;
  releaseFingerprint: string;
  version: string;
  runClass: string;
}

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

export function estimatedTokens(totalChars: number): number {
  return Math.ceil(chars(totalChars) / 4);
}

export function recordUsage(event: UsageEvent): boolean {
  if (!usageTelemetryEnabled()) return false;
  try {
    const input = chars(event.inputChars);
    const output = chars(event.outputChars);
    const context = chars(event.contextChars);
    usageDatabase().query(`INSERT INTO usage_events(
      event_key,ts,event_kind,source,host,session_hash,turn_seq,tool_name,
      input_chars,output_chars,context_chars,estimated_tokens,duration_ms,item_count,success,
      release_fingerprint,version,run_class
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
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
      event.releaseFingerprint || process.env.CAIRN_RELEASE || releaseVersion,
      event.version || process.env.CAIRN_RELEASE || releaseVersion,
      event.runClass || telemetryRunClass(),
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
  const d = usageDatabase();
  const latest = d.query(`SELECT release_fingerprint AS releaseFingerprint,version
    FROM usage_events WHERE ts>=? AND run_class='human' AND source='user-prompt'
    ORDER BY ts DESC LIMIT 1`).get(sinceTs) as {
      releaseFingerprint: string;
      version: string;
    } | null;
  const releaseFingerprint = latest?.releaseFingerprint || process.env.CAIRN_RELEASE || releaseVersion;
  const version = latest?.version || releaseVersion;
  const where = "ts>=? AND run_class='human' AND release_fingerprint=?";
  const totalMetrics = d.query(`SELECT ${metrics} FROM usage_events WHERE ${where}`)
    .get(sinceTs, releaseFingerprint) as Omit<
      UsageGroup, "eventKind" | "source" | "host" | "toolName"
      | "releaseFingerprint" | "version" | "runClass"
    >;
  const identity = { releaseFingerprint, version, runClass: "human" };
  const totals: UsageGroup = {
    eventKind: "", source: "", host: "", toolName: "", ...identity, ...totalMetrics,
  };
  const groups = d.query(`SELECT event_kind AS eventKind,source,host,tool_name AS toolName,${metrics}
    FROM usage_events WHERE ${where}
    GROUP BY event_kind,source,host,tool_name
    ORDER BY estimatedTokens DESC,events DESC`).all(sinceTs, releaseFingerprint)
    .map((group) => ({ ...(group as UsageGroup), ...identity }));
  const coverage = d.query(`SELECT
      COUNT(DISTINCT CASE WHEN session_hash != '' THEN session_hash END) AS sessions,
      COALESCE(MIN(ts),0) AS firstEventTs,COALESCE(MAX(ts),0) AS lastEventTs,
      COALESCE(MAX(CASE WHEN event_kind='context' THEN ts ELSE 0 END),0) AS latestContextTs,
      COALESCE(MAX(CASE WHEN event_kind='tool' THEN ts ELSE 0 END),0) AS latestToolTs
    FROM usage_events WHERE ${where}`).get(sinceTs, releaseFingerprint) as {
      sessions: number;
      firstEventTs: number;
      lastEventTs: number;
      latestContextTs: number;
      latestToolTs: number;
    };
  const latestPrompt = d.query(`SELECT estimated_tokens AS tokens FROM usage_events
    WHERE ${where} AND event_kind='context' AND source='user-prompt'
    ORDER BY ts DESC LIMIT 1`).get(sinceTs, releaseFingerprint) as { tokens: number } | null;
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
    toolTelemetryLagMs: coverage.latestToolTs > 0
      && coverage.latestContextTs > coverage.latestToolTs
      ? coverage.latestContextTs - coverage.latestToolTs
      : 0,
    toolTelemetryMissing: coverage.latestContextTs > 0 && coverage.latestToolTs === 0,
    ...identity,
  };
  return { sinceTs, totals, impact, groups };
}

export function jsonChars(value: unknown): number {
  try { return JSON.stringify(value).length; }
  catch { return 0; }
}
