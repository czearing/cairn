import { createHash, randomUUID } from "node:crypto";
import { releaseFingerprint, releaseVersion, telemetryRunClass } from "./release";
import { resultIds, structuredResult } from "./telemetry-entities";
import { telemetryDatabase } from "./telemetry-schema";
import { estimatedTokens, jsonChars, positive } from "./telemetry-size";

export type TelemetryHost = "copilot" | "claude";
export interface TelemetryRunIdentity {
  host: TelemetryHost;
  sessionId: string;
  turnSeq: number;
}
export interface TelemetryEvent {
  kind: "context" | "tool_transport";
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
      input.catalogVersion, runClass, input.ts ?? Date.now(),
      estimatedTokens(input.injectedChars),
    );
    db.query(`UPDATE telemetry_events SET run_id=?,release_fingerprint=?,version=?,run_class=?
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
    db.query(`INSERT OR IGNORE INTO telemetry_events(
      event_key,run_id,host,session_hash,turn_seq,ts,kind,source,tool_name,
      entity_type,entity_hash,success,input_tokens,output_tokens,estimated_tokens,
      duration_ms,item_count,value,release_fingerprint,version,run_class
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      hash(`${input.eventKey}\0${suffix}`, 64), runId, input.host,
      sessionHash(input.sessionId), input.turnSeq, Date.now(), input.kind, "host",
      input.toolName || "", input.entityType || "", entityHash(input.entityId || ""),
      Number(input.success !== false), inputTokens, outputTokens, inputTokens + outputTokens,
      input.durationMs || 0, input.itemCount || 0, input.value || 0,
      run?.release_fingerprint || "", run?.version || "", run?.run_class || telemetryRunClass(),
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
  recordEvent({
    ...input, kind: "tool", toolName: tool,
    inputTokens: estimatedTokens(jsonChars(input.args)),
    outputTokens: estimatedTokens(jsonChars(input.result)),
    itemCount: Array.isArray(parsed) ? parsed.length : ids.length,
  });
  const entities = (kind: string, type: string, values: string[]) =>
    [...new Set(values.filter(Boolean))].forEach((id) =>
      recordEvent({ ...input, kind, toolName: tool, entityType: type, entityId: id }));
  const strings = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  if (tool === "skill_select") entities("skill_selected", "skill", strings(input.args.ids));
  if (tool === "skill_create") entities("skill_created", "skill", ids);
  if (tool === "skill_edit") entities("skill_edited", "skill", [String(input.args.id || "")]);
  if (tool === "brain_search") entities("brain_returned", "brain", ids);
  if (tool === "brain_create") entities("brain_created", "brain", ids);
  if (tool === "brain_mutate") entities("brain_mutated", "brain", [String(input.args.id || "")]);
  if (tool === "brain_delete") entities("brain_deleted", "brain", [String(input.args.id || "")]);
  if (tool === "brain_create" || tool === "brain_mutate") {
    entities("brain_referenced", "brain", strings(input.args.edges));
  }
  try {
    telemetryDatabase()?.query(`UPDATE telemetry_runs SET tool_calls=tool_calls+1,
      tool_failures=tool_failures+? WHERE run_id=?`)
      .run(Number(!input.success), telemetryRunId(input));
  } catch { /* telemetry never blocks the host */ }
}

export function recordTelemetryState(input: TelemetryRunIdentity & {
  eventKey: string; kind: "stop_blocked" | "visibility_failure" | "deferred";
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
