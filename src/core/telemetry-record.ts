import { createHash, randomUUID } from "node:crypto";
import { releaseFingerprint, releaseVersion, telemetryRunClass } from "./release";
import { runtimeIdentityFromResult, type RuntimeIdentity } from "./runtime-identity";
import { resultIds, structuredResult } from "./telemetry-entities";
import { telemetryDatabase } from "./telemetry-schema";
import { estimatedTokens, jsonChars, positive } from "./telemetry-size";
import { toolEntityObservations } from "./telemetry-tool-entities";
import type { TelemetryEvent, TelemetryRunIdentity } from "./telemetry-record-types";
export type { TelemetryEvent, TelemetryHost, TelemetryRunIdentity } from "./telemetry-record-types";

const hash = (value: string, length = 16): string =>
  value ? createHash("sha256").update(value).digest("hex").slice(0, length) : "";
const sessionHash = (value = ""): string => hash(value);
const entityHash = (value: string): string => hash(value, 24);

export const telemetryRunId = ({ host, sessionId, turnSeq }: TelemetryRunIdentity): string =>
  hash(`${host}\0${sessionId}\0${turnSeq}`, 32);

export function recordTelemetry(input: TelemetryEvent): boolean {
  try {
    const db = telemetryDatabase();
    if (!db) return false;
    const inputChars = positive(input.inputChars);
    const outputChars = positive(input.outputChars);
    const contextChars = positive(input.contextChars);
    const eventKey = hash(input.eventKey || randomUUID(), 64);
    const session = sessionHash(input.sessionId);
    const turnSeq = positive(input.turnSeq);
    const runId = input.host && input.sessionId
      ? hash(`${input.host}\0${input.sessionId}\0${turnSeq}`, 32)
      : "";
    const run = runId ? db.query(`SELECT release_fingerprint,version,run_class
      FROM telemetry_runs WHERE run_id=?`).get(runId) as {
        release_fingerprint: string; version: string; run_class: string;
      } | null : null;
    db.query(`INSERT OR IGNORE INTO telemetry_events(
      event_key,run_id,host,session_hash,turn_seq,ts,kind,source,tool_name,success,
      input_chars,output_chars,context_chars,estimated_tokens,duration_ms,item_count,
      release_fingerprint,version,run_class
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      eventKey, runId, input.host || "", session, turnSeq, input.ts ?? Date.now(),
      input.kind, input.source, input.toolName || "", Number(input.success !== false),
      inputChars, outputChars, contextChars,
      estimatedTokens(inputChars + outputChars + contextChars),
      positive(input.durationMs), positive(input.itemCount),
      run?.release_fingerprint || input.releaseFingerprint
        || process.env.CAIRN_RELEASE || releaseVersion,
      run?.version || input.version || process.env.CAIRN_RELEASE || releaseVersion,
      run?.run_class || input.runClass || telemetryRunClass(),
    );
    return true;
  } catch {
    return false;
  }
}

export function beginTelemetryRun(input: TelemetryRunIdentity & {
  promptHash: string;
  catalogVersion: string;
  injectedChars: number;
  model?: string;
  ts?: number;
}): boolean {
  try {
    const db = telemetryDatabase();
    if (!db || !input.sessionId) return false;
    const runId = telemetryRunId(input);
    const release = releaseFingerprint(input.promptHash, input.catalogVersion);
    const version = process.env.CAIRN_RELEASE || releaseVersion;
    const runClass = telemetryRunClass();
    const startedTs = input.ts ?? Date.now();
    db.query(`UPDATE telemetry_runs SET ended_ts=?,status='superseded'
      WHERE host=? AND session_hash=? AND status='active' AND run_id!=?`).run(
      startedTs, input.host, sessionHash(input.sessionId), runId,
    );
    db.query(`INSERT INTO telemetry_runs(
      run_id,host,session_hash,turn_seq,release_fingerprint,version,model,prompt_hash,
      catalog_version,run_class,started_ts,injected_tokens
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(run_id) DO UPDATE SET release_fingerprint=excluded.release_fingerprint,
      model=excluded.model,prompt_hash=excluded.prompt_hash,
      catalog_version=excluded.catalog_version,run_class=excluded.run_class,
      injected_tokens=excluded.injected_tokens`).run(
      runId, input.host, sessionHash(input.sessionId), input.turnSeq,
      release, version, input.model || "", input.promptHash,
      input.catalogVersion, runClass, startedTs,
      estimatedTokens(input.injectedChars),
    );
    db.query(`UPDATE telemetry_events SET run_id=?,
      release_fingerprint=CASE WHEN runtime_release_fingerprint!='' OR release_fingerprint='unknown'
        THEN release_fingerprint ELSE ? END,
      version=CASE WHEN runtime_version!='' OR version='unknown' THEN version ELSE ? END,run_class=?
      WHERE host=? AND session_hash=? AND turn_seq=?`).run(
      runId, release, version, runClass, input.host, sessionHash(input.sessionId), input.turnSeq,
    );
    return true;
  } catch {
    return false;
  }
}

function recordEvent(input: TelemetryRunIdentity & {
  eventKey: string; kind: string; toolName?: string; entityType?: string;
  entityId?: string; success?: boolean; inputTokens?: number;
  outputTokens?: number; durationMs?: number; itemCount?: number; value?: number;
  runtime?: RuntimeIdentity | null; runtimeExpected?: boolean;
  rank?: number; scoreBucket?: number;
}): void {
  try {
    const db = telemetryDatabase();
    if (!db || !input.sessionId) return;
    const runId = telemetryRunId(input);
    const run = db.query(`SELECT release_fingerprint,version,run_class FROM telemetry_runs
      WHERE run_id=?`).get(runId) as {
        release_fingerprint: string; version: string; run_class: string;
      } | null;
    const suffix = `${input.kind}\0${input.entityType || ""}\0${input.entityId || ""}`;
    const inputTokens = input.inputTokens || 0;
    const outputTokens = input.outputTokens || 0;
    const eventRelease = input.runtime?.releaseFingerprint
      || (input.runtimeExpected ? "unknown" : run?.release_fingerprint || "");
    const eventVersion = input.runtime?.version
      || (input.runtimeExpected ? "unknown" : run?.version || "");
    db.query(`INSERT OR IGNORE INTO telemetry_events(
      event_key,run_id,host,session_hash,turn_seq,ts,kind,source,tool_name,
      entity_type,entity_hash,success,input_tokens,output_tokens,estimated_tokens,
      duration_ms,item_count,value,release_fingerprint,version,run_class,
      runtime_release_fingerprint,runtime_version,rank,score_bucket
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      hash(`${input.eventKey}\0${suffix}`, 64), runId, input.host,
      sessionHash(input.sessionId), input.turnSeq, Date.now(), input.kind, "host",
      input.toolName || "", input.entityType || "", entityHash(input.entityId || ""),
      Number(input.success !== false), inputTokens, outputTokens, inputTokens + outputTokens,
      input.durationMs || 0, input.itemCount || 0, input.value || 0,
      eventRelease, eventVersion, run?.run_class || telemetryRunClass(),
      input.runtime?.releaseFingerprint || "", input.runtime?.version || "",
      input.rank || 0, input.scoreBucket || 0,
    );
  } catch { /* telemetry never blocks the host */ }
}

export function recordTelemetryTool(input: TelemetryRunIdentity & {
  eventKey: string; toolName: string; args: Record<string, unknown>;
  result: unknown; success: boolean; durationMs?: number;
}): void {
  const tool = input.toolName.toLowerCase().replace(/^.*(?:__|-)(?=(?:brain|skill)_)/, "");
  const parsed = structuredResult(input.result);
  const ids = resultIds(parsed);
  const runtime = runtimeIdentityFromResult(input.result);
  recordEvent({
    ...input, kind: "tool", toolName: tool,
    inputTokens: estimatedTokens(jsonChars(input.args)),
    outputTokens: estimatedTokens(jsonChars(parsed)),
    itemCount: Array.isArray(parsed) ? parsed.length : ids.length,
    runtime,
    runtimeExpected: /^(brain|skill)_/.test(tool),
  });
  for (const observation of toolEntityObservations(tool, input.args, parsed, ids)) {
    recordEvent({ ...input, toolName: tool, ...observation });
  }
  try {
    telemetryDatabase()?.query(`UPDATE telemetry_runs SET tool_calls=tool_calls+1,
      tool_failures=tool_failures+? WHERE run_id=?`)
      .run(Number(!input.success), telemetryRunId(input));
  } catch { /* telemetry never blocks the host */ }
}

export function recordTelemetryState(input: TelemetryRunIdentity & {
  eventKey: string;
  kind: "stop_blocked" | "completion_blocked" | "visibility_failure" | "deferred";
}): void {
  recordEvent({ ...input, kind: input.kind });
}

export function finishTelemetryRun(input: TelemetryRunIdentity & {
  completed: boolean; workflowPassed: boolean; skillUsed: boolean;
  brainUsed: boolean; stopNudges: number; status?: string;
}): void {
  try {
    telemetryDatabase()?.query(`UPDATE telemetry_runs SET ended_ts=?,completed=?,
      workflow_passed=?,skill_used=?,brain_used=?,stop_nudges=?,status=? WHERE run_id=?`).run(
      Date.now(), Number(input.completed), Number(input.workflowPassed), Number(input.skillUsed),
      Number(input.brainUsed), input.stopNudges, input.status || "completed", telemetryRunId(input),
    );
  } catch { /* telemetry never blocks the host */ }
}
