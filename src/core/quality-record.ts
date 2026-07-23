import { createHash } from "node:crypto";
import { estimatedTokens, jsonChars } from "./usage";
import { qualityDatabase } from "./quality-schema";
import type { PromptEvaluation } from "../prompt-eval/types";
import {
  promptFingerprint,
  releaseFingerprint,
  releaseVersion,
  telemetryRunClass,
} from "./release";

export type QualityHost = "copilot" | "claude";

export interface RunIdentity {
  host: QualityHost;
  sessionId: string;
  turnSeq: number;
}

const hash = (value: string, length = 16): string =>
  value ? createHash("sha256").update(value).digest("hex").slice(0, length) : "";
const sessionHash = (value: string): string => hash(value);
const entityHash = (value: string): string => hash(value, 24);

export const qualityRunId = ({ host, sessionId, turnSeq }: RunIdentity): string =>
  hash(`${host}\0${sessionId}\0${turnSeq}`, 32);

export function qualityResultSucceeded(result: unknown): boolean {
  if (!result || typeof result !== "object") return true;
  const value = result as { success?: unknown; isError?: unknown; resultType?: unknown };
  return value.success !== false && value.isError !== true
    && (value.resultType == null || value.resultType === "success");
}

export function beginQualityRun(input: RunIdentity & {
  promptHash: string;
  catalogVersion: string;
  injectedChars: number;
  model?: string;
  ts?: number;
}): boolean {
  try {
    const db = qualityDatabase();
    if (!db || !input.sessionId) return false;
    const runId = qualityRunId(input);
    const release = releaseFingerprint(input.promptHash, input.catalogVersion);
    const version = process.env.CAIRN_RELEASE || releaseVersion;
    const runClass = telemetryRunClass();
    db.query(`INSERT INTO quality_runs(
      run_id,host,session_hash,turn_seq,release_fingerprint,version,model,prompt_hash,
      catalog_version,run_class,started_ts,injected_tokens
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(run_id) DO UPDATE SET
      release_fingerprint=excluded.release_fingerprint,model=excluded.model,
      prompt_hash=excluded.prompt_hash,catalog_version=excluded.catalog_version,
      run_class=excluded.run_class,
      injected_tokens=excluded.injected_tokens`).run(
      runId, input.host, sessionHash(input.sessionId), input.turnSeq,
      release, version, input.model || "", input.promptHash,
      input.catalogVersion, runClass, input.ts ?? Date.now(),
      estimatedTokens(input.injectedChars),
    );
    const hasUsage = db.query(`SELECT 1 AS ok FROM sqlite_master
      WHERE type='table' AND name='usage_events'`).get();
    if (hasUsage) {
      db.query(`UPDATE usage_events SET release_fingerprint=?,version=?,run_class=?
        WHERE host=? AND session_hash=? AND turn_seq=?`).run(
        release, version, runClass, input.host, sessionHash(input.sessionId), input.turnSeq,
      );
    }
    return true;
  } catch {
    return false;
  }
}

function structured(value: unknown): unknown {
  if (typeof value === "string") {
    try { return structured(JSON.parse(value)); } catch { return value; }
  }
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(structured);
  const record = value as Record<string, unknown>;
  if (typeof record.id === "string") return record;
  for (const key of ["textResultForLlm", "toolResult", "result"]) {
    if (record[key] != null) return structured(record[key]);
  }
  if (typeof record.text === "string") return structured(record.text);
  if (Array.isArray(record.content)) {
    return structured(record.content.length === 1 ? record.content[0] : record.content);
  }
  return record;
}

function ids(value: unknown): string[] {
  const parsed = structured(value);
  if (Array.isArray(parsed)) return parsed.flatMap(ids);
  if (!parsed || typeof parsed !== "object") return [];
  const id = (parsed as Record<string, unknown>).id;
  return typeof id === "string" && id.trim() ? [id.trim()] : [];
}

function event(input: RunIdentity & {
  eventKey: string;
  kind: string;
  toolName?: string;
  entityType?: string;
  entityId?: string;
  success?: boolean;
  inputTokens?: number;
  outputTokens?: number;
  durationMs?: number;
  itemCount?: number;
  value?: number;
  ts?: number;
}): void {
  try {
    const db = qualityDatabase();
    if (!db || !input.sessionId) return;
    const suffix = `${input.kind}\0${input.entityType || ""}\0${input.entityId || ""}`;
    db.query(`INSERT INTO quality_events(
      event_key,run_id,host,session_hash,turn_seq,ts,kind,tool_name,entity_type,
      entity_hash,success,input_tokens,output_tokens,duration_ms,item_count,value
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(event_key) DO NOTHING`).run(
      hash(`${input.eventKey}\0${suffix}`, 64), qualityRunId(input), input.host,
      sessionHash(input.sessionId), input.turnSeq, input.ts ?? Date.now(), input.kind,
      input.toolName || "", input.entityType || "", entityHash(input.entityId || ""),
      Number(input.success !== false), input.inputTokens || 0, input.outputTokens || 0,
      input.durationMs || 0, input.itemCount || 0, input.value || 0,
    );
  } catch { /* telemetry never blocks the host */ }
}

export function recordQualityTool(input: RunIdentity & {
  eventKey: string;
  toolName: string;
  args: Record<string, unknown>;
  result: unknown;
  success: boolean;
  durationMs?: number;
}): void {
  const tool = input.toolName.toLowerCase().replace(/^.*(?:__|-)(?=(?:brain|skill)_)/, "");
  const parsed = structured(input.result);
  const resultIds = ids(parsed);
  event({
    ...input, kind: "tool", toolName: tool,
    inputTokens: estimatedTokens(jsonChars(input.args)),
    outputTokens: estimatedTokens(jsonChars(input.result)),
    itemCount: Array.isArray(parsed) ? parsed.length : resultIds.length,
  });
  const recordIds = (kind: string, type: string, values: string[]) =>
    [...new Set(values.filter(Boolean))].forEach((id) =>
      event({ ...input, kind, toolName: tool, entityType: type, entityId: id })
    );
  if (tool === "skill_select") recordIds("skill_selected", "skill", Array.isArray(input.args.ids) ? input.args.ids as string[] : []);
  if (tool === "skill_create") recordIds("skill_created", "skill", resultIds);
  if (tool === "skill_edit") recordIds("skill_edited", "skill", [String(input.args.id || "")]);
  if (tool === "brain_search") recordIds("brain_returned", "brain", resultIds);
  if (tool === "brain_create") recordIds("brain_created", "brain", resultIds);
  if (tool === "brain_mutate") recordIds("brain_mutated", "brain", [String(input.args.id || "")]);
  if (tool === "brain_delete") recordIds("brain_deleted", "brain", [String(input.args.id || "")]);
  if (tool === "brain_create" || tool === "brain_mutate") {
    recordIds("brain_referenced", "brain", Array.isArray(input.args.edges) ? input.args.edges as string[] : []);
  }
  try {
    qualityDatabase()?.query(`UPDATE quality_runs SET tool_calls=tool_calls+1,
      tool_failures=tool_failures+? WHERE run_id=?`)
      .run(Number(!input.success), qualityRunId(input));
  } catch { /* telemetry never blocks the host */ }
}

export function recordQualityState(input: RunIdentity & {
  eventKey: string;
  kind: "stop_blocked" | "visibility_failure" | "deferred";
}): void {
  event({ ...input, kind: input.kind });
}

export function finishQualityRun(input: RunIdentity & {
  completed: boolean;
  workflowPassed: boolean;
  skillUsed: boolean;
  brainUsed: boolean;
  stopNudges: number;
  status?: string;
}): void {
  try {
    qualityDatabase()?.query(`UPDATE quality_runs SET ended_ts=?,completed=?,workflow_passed=?,
      skill_used=?,brain_used=?,stop_nudges=?,status=? WHERE run_id=?`).run(
      Date.now(), Number(input.completed), Number(input.workflowPassed), Number(input.skillUsed),
      Number(input.brainUsed), input.stopNudges, input.status || "completed", qualityRunId(input),
    );
  } catch { /* telemetry never blocks the host */ }
}

export { promptFingerprint, releaseFingerprint };

export function recordPromptEvaluation(result: PromptEvaluation): void {
  try {
    const db = qualityDatabase();
    if (!db) return;
    const createdTs = Date.now();
    const evaluationId = hash([
      result.baselinePromptHash,
      result.candidatePromptHash,
      result.qualityDefinitionHash,
      createdTs,
    ].join("\0"), 32);
    db.query(`INSERT INTO prompt_evaluations(
      evaluation_id,baseline_prompt_hash,candidate_prompt_hash,quality_definition_hash,
      accepted,token_reduction,safe_token_reduction,quality_improvements,
      quality_checks,compared_runs,created_ts
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
      evaluationId,
      result.baselinePromptHash,
      result.candidatePromptHash,
      result.qualityDefinitionHash,
      Number(result.accepted),
      result.tokenReduction,
      result.safeTokenReduction,
      result.qualityImprovements,
      result.qualityChecks,
      result.comparedRuns,
      createdTs,
    );
  } catch { /* telemetry never blocks evaluation */ }
}
