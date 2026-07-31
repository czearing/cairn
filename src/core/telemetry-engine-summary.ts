import { telemetryDatabase } from "./telemetry-schema";

interface ToolSchemaMetric {
  toolName: string;
  chars: number;
  estimatedTokens: number;
}

interface SearchStageMetric {
  stage: string;
  events: number;
  totalDurationMs: number;
  averageDurationMs: number;
  maximumDurationMs: number;
}

interface EngineTransportMetric {
  source: string;
  operation: string;
  calls: number;
  averageDurationMs: number;
  maximumDurationMs: number;
  failures: number;
}

export interface EngineSummary {
  releaseFingerprint: string;
  version: string;
  toolSchemas: {
    tools: number;
    chars: number;
    estimatedTokens: number;
    version: string;
    definitions: ToolSchemaMetric[];
  };
  searchStages: SearchStageMetric[];
  engineTransports: EngineTransportMetric[];
  parity: { checks: number; mismatches: number };
}

export function telemetryEngineSummary(days: number): EngineSummary {
  const empty = {
    releaseFingerprint: "",
    version: "",
    toolSchemas: { tools: 0, chars: 0, estimatedTokens: 0, version: "", definitions: [] },
    searchStages: [],
    engineTransports: [],
    parity: { checks: 0, mismatches: 0 },
  };
  const db = telemetryDatabase();
  if (!db) return empty;
  const sinceTs = Date.now() - Math.max(1, days) * 86_400_000;
  const latest = db.query(`SELECT release_fingerprint AS releaseFingerprint,version
    FROM telemetry_events
    WHERE kind IN ('tool_schema','search_stage','engine_transport','engine_parity') AND ts>=?
    ORDER BY ts DESC LIMIT 1`).get(sinceTs) as {
      releaseFingerprint: string;
      version: string;
    } | null;
  if (!latest?.releaseFingerprint) return empty;
  // Tool schemas are emitted once per MCP server start, so their release fingerprint lags the newest
  // engine activity whenever the server has not restarted. Anchoring them on the shared fingerprint
  // silently reported zero tools; give them their own anchor and disclose the release they describe.
  const schemaAnchor = db.query(`SELECT release_fingerprint AS releaseFingerprint,version
    FROM telemetry_events
    WHERE kind='tool_schema' AND ts>=?
    ORDER BY ts DESC LIMIT 1`).get(sinceTs) as {
      releaseFingerprint: string;
      version: string;
    } | null;
  const definitions = schemaAnchor?.releaseFingerprint
    ? db.query(`WITH ranked AS (
        SELECT tool_name AS toolName,context_chars AS chars,
          estimated_tokens AS estimatedTokens,
          ROW_NUMBER() OVER (PARTITION BY tool_name ORDER BY ts DESC) AS position
        FROM telemetry_events
        WHERE kind='tool_schema' AND release_fingerprint=? AND ts>=?
      )
      SELECT toolName,chars,estimatedTokens FROM ranked WHERE position=1
      ORDER BY estimatedTokens DESC,toolName`).all(
        schemaAnchor.releaseFingerprint,
        sinceTs,
      ) as ToolSchemaMetric[]
    : [];
  const searchStages = db.query(`SELECT source AS stage,COUNT(*) AS events,
      COALESCE(SUM(duration_ms),0) AS totalDurationMs,
      ROUND(COALESCE(AVG(duration_ms),0),1) AS averageDurationMs,
      COALESCE(MAX(duration_ms),0) AS maximumDurationMs
    FROM telemetry_events
    WHERE kind='search_stage' AND release_fingerprint=? AND ts>=?
    GROUP BY source ORDER BY totalDurationMs DESC,stage`).all(
      latest.releaseFingerprint,
      sinceTs,
    ) as SearchStageMetric[];
  const engineTransports = db.query(`SELECT source,tool_name AS operation,
      COUNT(*) AS calls,ROUND(COALESCE(AVG(duration_ms),0),1) AS averageDurationMs,
      COALESCE(MAX(duration_ms),0) AS maximumDurationMs,
      COALESCE(SUM(CASE WHEN success=0 THEN 1 ELSE 0 END),0) AS failures
    FROM telemetry_events
    WHERE kind='engine_transport' AND release_fingerprint=? AND ts>=?
    GROUP BY source,tool_name ORDER BY calls DESC,source,operation`).all(
      latest.releaseFingerprint,
      sinceTs,
    ) as EngineTransportMetric[];
  const parity = db.query(`SELECT COUNT(*) AS checks,
      COALESCE(SUM(CASE WHEN success=0 THEN 1 ELSE 0 END),0) AS mismatches
    FROM telemetry_events
    WHERE kind='engine_parity' AND release_fingerprint=? AND ts>=?`).get(
      latest.releaseFingerprint,
      sinceTs,
    ) as { checks: number; mismatches: number };
  return {
    ...latest,
    toolSchemas: {
      tools: definitions.length,
      chars: definitions.reduce((total, item) => total + item.chars, 0),
      estimatedTokens: definitions.reduce((total, item) => total + item.estimatedTokens, 0),
      version: schemaAnchor?.version || "",
      definitions,
    },
    searchStages,
    engineTransports,
    parity,
  };
}
