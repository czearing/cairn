import { releaseVersion } from "./release";
import { telemetryDatabase } from "./telemetry-schema";

export interface TelemetryGroup {
  eventKind: string; source: string; host: string; toolName: string;
  events: number; estimatedTokens: number; minimumTokens: number;
  maximumTokens: number; inputChars: number; outputChars: number;
  contextChars: number; averageDurationMs: number; failures: number;
  releaseFingerprint: string; version: string; runClass: string;
}

export interface TelemetryImpact {
  prompts: number; sessions: number; currentPromptTokens: number;
  measuredTokensPerPrompt: number; contextTokens: number; toolTokens: number;
  contextPercent: number; toolPercent: number; firstEventTs: number;
  lastEventTs: number; releaseFingerprint: string; version: string; runClass: string;
}

const metrics = `COUNT(*) AS events,COALESCE(SUM(estimated_tokens),0) AS estimatedTokens,
  COALESCE(MIN(estimated_tokens),0) AS minimumTokens,
  COALESCE(MAX(estimated_tokens),0) AS maximumTokens,
  COALESCE(SUM(input_chars),0) AS inputChars,
  COALESCE(SUM(output_chars),0) AS outputChars,
  COALESCE(SUM(context_chars),0) AS contextChars,
  ROUND(COALESCE(AVG(duration_ms),0),1) AS averageDurationMs,
  COALESCE(SUM(CASE WHEN success=0 THEN 1 ELSE 0 END),0) AS failures`;

export function telemetryCostSummary(days = 7): {
  sinceTs: number; totals: TelemetryGroup; impact: TelemetryImpact; groups: TelemetryGroup[];
} {
  const sinceTs = Date.now() - Math.max(1, days) * 86_400_000;
  const db = telemetryDatabase();
  const latest = db?.query(`SELECT e.release_fingerprint AS releaseFingerprint,e.version
    FROM telemetry_events e JOIN telemetry_runs r USING(run_id)
    WHERE e.ts>=? AND e.run_class='human' AND r.status='completed'
      AND e.kind='context' AND e.source='user-prompt'
    ORDER BY e.ts DESC LIMIT 1`).get(sinceTs) as {
      releaseFingerprint: string; version: string;
    } | null;
  const releaseFingerprint = latest?.releaseFingerprint || process.env.CAIRN_RELEASE || releaseVersion;
  const version = latest?.version || releaseVersion;
  const identity = { releaseFingerprint, version, runClass: "human" };
  const empty = {
    eventKind: "", source: "", host: "", toolName: "", ...identity,
    events: 0, estimatedTokens: 0, minimumTokens: 0, maximumTokens: 0,
    inputChars: 0, outputChars: 0, contextChars: 0, averageDurationMs: 0, failures: 0,
  };
  if (!db) {
    return {
      sinceTs, totals: empty, groups: [],
      impact: {
        ...identity, prompts: 0, sessions: 0, currentPromptTokens: 0,
        measuredTokensPerPrompt: 0, contextTokens: 0, toolTokens: 0,
        contextPercent: 0, toolPercent: 0, firstEventTs: 0, lastEventTs: 0,
      },
    };
  }
  const where = `ts>=? AND run_class='human' AND release_fingerprint=?
    AND kind IN ('context','tool') AND run_id IN (
      SELECT run_id FROM telemetry_runs WHERE status='completed'
    )`;
  const totalMetrics = db.query(`SELECT ${metrics} FROM telemetry_events WHERE ${where}`)
    .get(sinceTs, releaseFingerprint) as Omit<
      TelemetryGroup, "eventKind" | "source" | "host" | "toolName"
      | "releaseFingerprint" | "version" | "runClass"
    >;
  const totals = { ...empty, ...totalMetrics };
  const groups = db.query(`SELECT kind AS eventKind,source,host,tool_name AS toolName,${metrics}
    FROM telemetry_events WHERE ${where}
    GROUP BY kind,source,host,tool_name
    ORDER BY estimatedTokens DESC,events DESC`).all(sinceTs, releaseFingerprint)
    .map((group) => ({ ...(group as TelemetryGroup), ...identity }));
  const coverage = db.query(`SELECT
    COUNT(DISTINCT CASE WHEN session_hash!='' THEN session_hash END) AS sessions,
    COALESCE(MIN(ts),0) AS firstEventTs,COALESCE(MAX(ts),0) AS lastEventTs
    FROM telemetry_events WHERE ${where}`).get(sinceTs, releaseFingerprint) as {
      sessions: number; firstEventTs: number; lastEventTs: number;
    };
  const runCoverage = db.query(`SELECT
    COUNT(*) AS prompts,COALESCE((
      SELECT estimated_tokens FROM telemetry_events WHERE ts>=?
        AND run_class='human' AND release_fingerprint=?
        AND kind='context' AND source='user-prompt' AND run_id IN (
          SELECT run_id FROM telemetry_runs WHERE status='completed'
        ) ORDER BY ts DESC LIMIT 1
    ),0) AS currentPromptTokens
    FROM telemetry_events WHERE ts>=? AND run_class='human' AND release_fingerprint=?
      AND kind='context' AND source='user-prompt' AND run_id IN (
        SELECT run_id FROM telemetry_runs WHERE status='completed'
      )`)
    .get(sinceTs, releaseFingerprint, sinceTs, releaseFingerprint) as {
      prompts: number; currentPromptTokens: number;
    };
  const contextTokens = groups.filter((group) => group.eventKind === "context")
    .reduce((total, group) => total + group.estimatedTokens, 0);
  const toolTokens = groups.filter((group) => group.eventKind === "tool")
    .reduce((total, group) => total + group.estimatedTokens, 0);
  const totalTokens = totals.estimatedTokens;
  return {
    sinceTs, totals, groups,
    impact: {
      ...identity, ...coverage, ...runCoverage,
      measuredTokensPerPrompt: runCoverage.prompts > 0
        ? Math.round(totalTokens / runCoverage.prompts) : 0,
      contextTokens, toolTokens,
      contextPercent: totalTokens > 0 ? Math.round(contextTokens * 100 / totalTokens) : 0,
      toolPercent: totalTokens > 0 ? Math.round(toolTokens * 100 / totalTokens) : 0,
    },
  };
}
