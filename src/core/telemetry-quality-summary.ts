import { telemetryDatabase } from "./telemetry-schema";
import type { QualityMetrics, QualitySummary } from "./telemetry-quality-types";
export type { QualityMetrics, QualitySummary } from "./telemetry-quality-types";

const percent = (part: number, total: number): number =>
  total > 0 ? Math.round(part * 1000 / total) / 10 : 0;
const workloadSql = `CASE WHEN tool_calls<=10 THEN 'small'
  WHEN tool_calls<=50 THEN 'medium' ELSE 'large' END`;
type Workload = QualityMetrics["workload"];

// A run is comparable only when the hook layer and the Cairn runtime that served its calls are the
// same release. Hooks adopt a release on the next hook event while the MCP server keeps the build it
// started with, so release-spanning sessions are legitimately excluded — but the exclusion must be
// counted and reported, not silently dropped.
//
// Exclusion requires POSITIVE evidence of a different release. A call that simply failed to carry
// runtime identity is missing attribution, not proof of a split: treating it as mixed discarded whole
// runs on the strength of one unattributed call, which drove comparable runs to zero and made every
// quality claim unfalsifiable. Unattributed runs are reported as their own category instead.
const cairnToolSql = `(e.tool_name LIKE 'brain_%' OR e.tool_name LIKE 'skill_%')`;
const mismatchedRuntimeSql = `(EXISTS (
    SELECT 1 FROM telemetry_events e WHERE e.run_id=r.run_id AND e.kind='tool'
      AND ${cairnToolSql} AND e.runtime_version!='' AND e.runtime_version!=r.version
  ) OR EXISTS (
    SELECT 1 FROM telemetry_events e WHERE e.run_id=r.run_id AND e.kind='tool_transport'
      AND ${cairnToolSql} AND e.version!='' AND e.version!=r.version
  ))`;
const attributedRuntimeSql = `(EXISTS (
    SELECT 1 FROM telemetry_events e WHERE e.run_id=r.run_id AND e.kind='tool'
      AND ${cairnToolSql} AND e.runtime_version=r.version
  ) OR EXISTS (
    SELECT 1 FROM telemetry_events e WHERE e.run_id=r.run_id AND e.kind='tool_transport'
      AND ${cairnToolSql} AND e.version=r.version
  ))`;
// A run that never called a Cairn tool has no runtime to disagree with, so it stays comparable.
const cairnCallsSql = `EXISTS (
    SELECT 1 FROM telemetry_events e WHERE e.run_id=r.run_id
      AND e.kind IN ('tool','tool_transport') AND ${cairnToolSql}
  )`;
const comparableRuntimeSql = `(NOT ${mismatchedRuntimeSql}
  AND (${attributedRuntimeSql} OR NOT ${cairnCallsSql}))`;
const unattributedRuntimeSql = `(NOT ${mismatchedRuntimeSql}
  AND ${cairnCallsSql} AND NOT ${attributedRuntimeSql})`;

function releaseMetrics(
  sinceTs: number, release: string, host: string, model: string, workload: Workload
): QualityMetrics | null {
  const db = telemetryDatabase();
  if (!db || !release) return null;
  const dimensionSql = `FROM telemetry_runs r WHERE started_ts>=? AND release_fingerprint=? AND host=?
      AND run_class='human' AND status='completed'
      AND COALESCE(NULLIF(model,''),'unknown')=? AND ${workloadSql}=?`;
  const row = db.query(`SELECT COUNT(*) AS runs,
    ROUND(AVG(completed)*100,1) AS completedRate,
    ROUND(AVG(workflow_passed)*100,1) AS workflowRate,
    ROUND(AVG(tool_failures)*100.0/CASE WHEN tool_calls=0 THEN 1 ELSE tool_calls END,1) AS toolFailureRate,
    ROUND(AVG(stop_nudges),1) AS averageStopNudges,
    ROUND(AVG(injected_tokens + COALESCE((
      SELECT SUM(estimated_tokens) FROM telemetry_events e
      WHERE e.run_id=r.run_id AND e.kind='tool'
        AND e.version=r.version
    ),0)),1) AS tokensPerRun
    ${dimensionSql} AND ${comparableRuntimeSql}`)
    .get(sinceTs, release, host, model, workload) as
      Omit<QualityMetrics, "release" | "workload" | "excludedRuns" | "unattributedRuns"> | null;
  const excluded = db.query(`SELECT
    COALESCE(SUM(CASE WHEN ${mismatchedRuntimeSql} THEN 1 ELSE 0 END),0) AS excludedRuns,
    COALESCE(SUM(CASE WHEN ${unattributedRuntimeSql} THEN 1 ELSE 0 END),0) AS unattributedRuns
    ${dimensionSql}`)
    .get(sinceTs, release, host, model, workload) as
      { excludedRuns: number; unattributedRuns: number } | null;
  const excludedRuns = excluded?.excludedRuns ?? 0;
  const unattributedRuns = excluded?.unattributedRuns ?? 0;
  return row?.runs ? { release, workload, excludedRuns, unattributedRuns, ...row } : null;
}

const delta = (current: QualityMetrics, baseline: QualityMetrics | null) => baseline ? {
  tokensPerRun: Math.round((current.tokensPerRun - baseline.tokensPerRun) * 10) / 10,
  completedRate: Math.round((current.completedRate - baseline.completedRate) * 10) / 10,
  workflowRate: Math.round((current.workflowRate - baseline.workflowRate) * 10) / 10,
  toolFailureRate: Math.round((current.toolFailureRate - baseline.toolFailureRate) * 10) / 10,
} : null;

export function telemetryQualitySummary(days = 7): QualitySummary {
  const db = telemetryDatabase();
  if (!db) return empty();
  const sinceTs = Date.now() - Math.max(1, days) * 86_400_000;
  const latestIdentity = (db.query(`SELECT version,release_fingerprint AS releaseFingerprint FROM telemetry_runs
    WHERE started_ts>=? AND run_class='human' ORDER BY started_ts DESC LIMIT 1`)
    .get(sinceTs) as { version?: string; releaseFingerprint?: string } | null) ?? {};
  const latestVersion = latestIdentity.version || "";
  // Behavior rates are scoped to one release so they stay comparable, but pinning them to the newest
  // run's version blanks every rate for the whole window after each rebuild. Report the newest release
  // that actually has a completed sample instead, and surface the gap as an explicit issue.
  const minimumSample = Math.max(1, Number(process.env.CAIRN_TELEMETRY_MIN_SAMPLE || "1"));
  const sampleVersion = (db.query(`SELECT version FROM telemetry_runs
    WHERE started_ts>=? AND run_class='human' AND status='completed' AND version!=''
    GROUP BY version HAVING COUNT(*)>=? ORDER BY MAX(started_ts) DESC LIMIT 1`)
    .get(sinceTs, minimumSample) as { version?: string } | null)?.version || latestVersion;
  const staleCutoff = Date.now()
    - Math.max(60_000, Number(process.env.CAIRN_TELEMETRY_STALE_RUN_MS || "1800000"));
  const stalledCutoff = Date.now()
    - Math.max(60_000, Number(process.env.CAIRN_TELEMETRY_STALLED_RUN_MS || "600000"));
  db.query(`UPDATE telemetry_runs SET ended_ts=?,status='abandoned'
    WHERE status='active' AND COALESCE((
      SELECT MAX(ts) FROM telemetry_events e WHERE e.run_id=telemetry_runs.run_id
    ),started_ts)<?`).run(Date.now(), staleCutoff);
  const runs = db.query(`WITH run_activity AS (
    SELECT r.*,COALESCE(MAX(e.ts),r.started_ts) AS lastActivityTs
    FROM telemetry_runs r LEFT JOIN telemetry_events e USING(run_id)
    WHERE r.started_ts>=? AND r.run_class='human'
    GROUP BY r.run_id
  ) SELECT
    COALESCE(SUM(CASE WHEN status='completed' AND version=? THEN 1 ELSE 0 END),0) AS closed,
    COALESCE(SUM(CASE WHEN status='active' THEN 1 ELSE 0 END),0) AS active,
    COALESCE(SUM(CASE WHEN status='active' AND lastActivityTs>=? THEN 1 ELSE 0 END),0) AS progressingActive,
    COALESCE(SUM(CASE WHEN status='active' AND lastActivityTs<? THEN 1 ELSE 0 END),0) AS stalledActive,
    COALESCE(SUM(CASE WHEN status='abandoned' AND version=? THEN 1 ELSE 0 END),0) AS abandoned,
    COALESCE(SUM(CASE WHEN status='superseded' AND version=? THEN 1 ELSE 0 END),0) AS superseded,
    COALESCE(SUM(CASE WHEN status='completed' AND version=? THEN completed ELSE 0 END),0) AS completed,
    COALESCE(SUM(CASE WHEN status='completed' AND version=? THEN workflow_passed ELSE 0 END),0) AS workflow,
    COALESCE(SUM(CASE WHEN status='completed' AND version=? THEN tool_failures ELSE 0 END),0) AS failures,
    COALESCE(MAX(CASE WHEN status='active' THEN (? - started_ts)/60000 ELSE 0 END),0) AS oldestActiveMinutes,
    COALESCE(MAX(CASE WHEN status='active' THEN (? - lastActivityTs)/60000 ELSE 0 END),0) AS oldestActiveActivityMinutes
    FROM run_activity`)
    .get(
      sinceTs, sampleVersion, stalledCutoff, stalledCutoff, sampleVersion, sampleVersion,
      sampleVersion, sampleVersion, sampleVersion, Date.now(), Date.now()
    ) as {
      active: number; closed: number; abandoned: number; superseded: number;
      progressingActive: number; stalledActive: number; oldestActiveActivityMinutes: number;
      completed: number; workflow: number; failures: number; oldestActiveMinutes: number;
    };
  const brain = db.query(`WITH returned AS (
      SELECT e.run_id,e.entity_hash,MIN(NULLIF(e.rank,0)) AS rank,
        MAX(e.score_bucket) AS scoreBucket,MIN(e.rowid) AS returnedRowId
      FROM telemetry_events e
      JOIN telemetry_runs r USING(run_id)
      WHERE e.ts>=? AND r.status='completed' AND e.kind='brain_returned' AND e.entity_hash!=''
        AND r.run_class='human' AND r.version=?
      GROUP BY e.run_id,e.entity_hash
    ), used AS (
      SELECT e.run_id,e.entity_hash,e.rowid AS usedRowId FROM telemetry_events e
      JOIN telemetry_runs r USING(run_id)
      WHERE e.ts>=? AND r.status='completed' AND r.run_class='human'
        AND r.version=? AND e.kind IN ('brain_referenced','brain_mutated') AND e.entity_hash!=''
    ), cross_session AS (
      SELECT returned.* FROM returned WHERE EXISTS (
        SELECT 1 FROM telemetry_events prior
        JOIN telemetry_runs prior_run ON prior_run.run_id=prior.run_id
        JOIN telemetry_runs returned_run ON returned_run.run_id=returned.run_id
        WHERE prior.entity_hash=returned.entity_hash AND prior.entity_type='brain'
          AND prior.entity_hash!='' AND prior_run.run_class='human'
          AND prior_run.session_hash!=returned_run.session_hash
          AND prior.rowid<returned.returnedRowId
      )
    )
    SELECT (SELECT COUNT(*) FROM returned) AS returnedNodes,
      (SELECT COUNT(*) FROM returned r WHERE EXISTS (
        SELECT 1 FROM used u WHERE u.run_id=r.run_id AND u.entity_hash=r.entity_hash
          AND u.usedRowId>r.returnedRowId
      )) AS usedReturnedNodes,
      (SELECT COUNT(*) FROM returned r WHERE r.rank>0 AND EXISTS (
        SELECT 1 FROM used u WHERE u.run_id=r.run_id AND u.entity_hash=r.entity_hash
          AND u.usedRowId>r.returnedRowId
      )) AS rankedUsedReturnedNodes,
      (SELECT COUNT(*) FROM returned r WHERE r.rank BETWEEN 1 AND 3 AND EXISTS (
        SELECT 1 FROM used u WHERE u.run_id=r.run_id AND u.entity_hash=r.entity_hash
          AND u.usedRowId>r.returnedRowId
      )) AS top3UsedReturnedNodes,
      COALESCE((SELECT MAX(r.rank) FROM returned r WHERE EXISTS (
        SELECT 1 FROM used u WHERE u.run_id=r.run_id AND u.entity_hash=r.entity_hash
          AND u.usedRowId>r.returnedRowId
      )),0) AS maxUsedRank,
      COALESCE((SELECT MIN(NULLIF(r.scoreBucket,0))*5 FROM returned r WHERE EXISTS (
        SELECT 1 FROM used u WHERE u.run_id=r.run_id AND u.entity_hash=r.entity_hash
          AND u.usedRowId>r.returnedRowId
      )),0) AS minimumUsedScorePercent,
      (SELECT COUNT(*) FROM cross_session) AS crossSessionEligibleNodes,
      (SELECT COUNT(*) FROM cross_session r WHERE EXISTS (
        SELECT 1 FROM used u WHERE u.run_id=r.run_id AND u.entity_hash=r.entity_hash
          AND u.usedRowId>r.returnedRowId
      ))
        AS crossSessionReusedNodes`)
    .get(sinceTs, sampleVersion, sinceTs, sampleVersion) as {
      returnedNodes: number; usedReturnedNodes: number; rankedUsedReturnedNodes: number;
      top3UsedReturnedNodes: number;
      maxUsedRank: number; minimumUsedScorePercent: number;
      crossSessionEligibleNodes: number; crossSessionReusedNodes: number;
    };
  const skills = db.query(`SELECT
    COUNT(DISTINCT CASE WHEN e.kind='skill_selected' THEN e.entity_hash END) AS selectedSkills,
    COUNT(DISTINCT CASE WHEN e.kind='skill_edited' THEN e.entity_hash END) AS editedSkills,
    COALESCE(SUM(CASE WHEN e.kind='visibility_failure' THEN 1 ELSE 0 END),0) AS visibilityFailures,
    COALESCE(SUM(CASE WHEN e.kind='stop_blocked' THEN 1 ELSE 0 END),0) AS workflowBlocks,
    COALESCE(SUM(CASE WHEN e.kind='completion_blocked' THEN 1 ELSE 0 END),0) AS completionBlocks,
    COALESCE(SUM(CASE WHEN e.kind='skill_correction_required' THEN 1 ELSE 0 END),0) AS skillCorrectionsRequired,
    COALESCE(SUM(CASE WHEN e.kind='skill_correction_resolved' THEN 1 ELSE 0 END),0) AS skillCorrectionsResolved,
    COALESCE(SUM(CASE WHEN e.kind='skill_correction_blocked' THEN 1 ELSE 0 END),0) AS skillCorrectionBlocks,
    COALESCE(SUM(CASE WHEN e.kind='skill_receipt_checked' THEN 1 ELSE 0 END),0) AS skillReceiptChecks,
    COALESCE(SUM(CASE WHEN e.kind='skill_receipt_checked' AND e.success=1 THEN 1 ELSE 0 END),0)
      AS completeSkillReceipts,
    COALESCE(SUM(CASE WHEN e.kind='skill_receipt_duplicate' THEN 1 ELSE 0 END),0) AS duplicateSkillReceipts,
    COALESCE(SUM(CASE WHEN e.kind='skill_receipt_checked' THEN e.value ELSE 0 END),0)
      AS expectedSkillReceiptSteps,
    COALESCE(SUM(CASE WHEN e.kind='skill_receipt_checked' THEN e.item_count ELSE 0 END),0)
      AS reportedSkillReceiptSteps
    FROM telemetry_events e JOIN telemetry_runs r USING(run_id)
    WHERE e.ts>=? AND r.run_class='human' AND r.status='completed' AND r.version=?`)
    .get(sinceTs, sampleVersion) as {
      selectedSkills: number; editedSkills: number; visibilityFailures: number;
      workflowBlocks: number; completionBlocks: number;
      skillCorrectionsRequired: number; skillCorrectionsResolved: number;
      skillCorrectionBlocks: number;
      skillReceiptChecks: number; completeSkillReceipts: number;
      duplicateSkillReceipts: number; expectedSkillReceiptSteps: number;
      reportedSkillReceiptSteps: number;
    };
  const runtime = db.query(`SELECT
    COALESCE(SUM(CASE WHEN e.runtime_version!='' THEN 1 ELSE 0 END),0) AS runtimeObservedCalls,
    COALESCE(SUM(CASE WHEN e.runtime_version='' THEN 1 ELSE 0 END),0) AS runtimeUnknownCalls,
    COALESCE(SUM(CASE WHEN e.runtime_version!='' AND e.runtime_version!=r.version
      THEN 1 ELSE 0 END),0) AS runtimeMismatchCalls
    FROM telemetry_events e JOIN telemetry_runs r USING(run_id)
    WHERE e.ts>=? AND r.version=? AND r.run_class='human' AND r.status='completed' AND e.kind='tool'
      AND (e.tool_name LIKE 'brain_%' OR e.tool_name LIKE 'skill_%')`).get(sinceTs, sampleVersion) as {
        runtimeObservedCalls: number; runtimeUnknownCalls: number; runtimeMismatchCalls: number;
      };
  const coherence = db.query(`SELECT
    COUNT(*) AS completedRuns,
    COALESCE(SUM(CASE WHEN ${mismatchedRuntimeSql} THEN 1 ELSE 0 END),0) AS mixedRuntimeRuns,
    COALESCE(SUM(CASE WHEN ${unattributedRuntimeSql} THEN 1 ELSE 0 END),0) AS unattributedRuntimeRuns
    FROM telemetry_runs r WHERE r.started_ts>=? AND r.version=?
      AND r.run_class='human' AND r.status='completed'`)
    .get(sinceTs, sampleVersion) as {
      completedRuns: number; mixedRuntimeRuns: number; unattributedRuntimeRuns: number;
    };
  const promptEvaluationCounts = db.query(`SELECT COUNT(*) AS total,
    COALESCE(SUM(accepted),0) AS accepted FROM telemetry_evaluations WHERE created_ts>=?`)
    .get(sinceTs) as { total: number; accepted: number };
  const latestPromptEvaluation = db.query(`SELECT candidate_prompt_hash AS candidatePromptHash,
    accepted,token_reduction AS tokenReduction,safe_token_reduction AS safeTokenReduction,
    quality_improvements AS qualityImprovements,quality_checks AS qualityChecks,
    compared_runs AS comparedRuns
    FROM telemetry_evaluations WHERE created_ts>=? ORDER BY created_ts DESC LIMIT 1`)
    .get(sinceTs) as {
      candidatePromptHash: string;
      accepted: number;
      tokenReduction: number;
      safeTokenReduction: number | null;
      qualityImprovements: number;
      qualityChecks: number;
      comparedRuns: number;
    } | null;
  const dimensions = db.query(`SELECT host,COALESCE(NULLIF(model,''),'unknown') AS model,
      ${workloadSql} AS workload,MAX(started_ts) AS latest
    FROM telemetry_runs WHERE started_ts>=? AND status='completed' AND run_class='human'
    GROUP BY host,COALESCE(NULLIF(model,''),'unknown'),${workloadSql}
    ORDER BY latest DESC`).all(sinceTs) as { host: string; model: string; workload: Workload }[];
  const comparisons = dimensions.flatMap(({ host, model, workload }) => {
    const releases = db.query(`SELECT release_fingerprint AS release,MAX(started_ts) AS latest
      FROM telemetry_runs WHERE started_ts>=? AND status='completed' AND run_class='human'
        AND host=? AND COALESCE(NULLIF(model,''),'unknown')=? AND ${workloadSql}=?
      GROUP BY release_fingerprint ORDER BY latest DESC LIMIT 2`)
      .all(sinceTs, host, model, workload) as { release: string }[];
    const current = releaseMetrics(sinceTs, releases[0]?.release || "", host, model, workload);
    if (!current) return [];
    const baseline = releaseMetrics(sinceTs, releases[1]?.release || "", host, model, workload);
    return [{ host, model, workload, current, baseline, delta: delta(current, baseline) }];
  });
  const latest = comparisons[0];
  return {
    latestVersion,
    sampleVersion,
    latestReleaseFingerprint: latestIdentity.releaseFingerprint || "",
    runs: runs.closed,
    activeRuns: runs.active,
    abandonedRuns: runs.abandoned,
    supersededRuns: runs.superseded,
    oldestActiveMinutes: Math.round(runs.oldestActiveMinutes),
    progressingActiveRuns: runs.progressingActive,
    stalledActiveRuns: runs.stalledActive,
    oldestActiveActivityMinutes: Math.round(runs.oldestActiveActivityMinutes),
    completedRate: percent(runs.completed, runs.closed),
    workflowRate: percent(runs.workflow, runs.closed),
    toolFailures: runs.failures,
    searchToUseRate: percent(brain.usedReturnedNodes, brain.returnedNodes),
    top3UseRate: percent(brain.top3UsedReturnedNodes, brain.rankedUsedReturnedNodes),
    ...brain,
    crossSessionReuseRate: percent(
      brain.crossSessionReusedNodes,
      brain.crossSessionEligibleNodes,
    ),
    crossSessionNodes: brain.crossSessionReusedNodes,
    observedNodes: brain.crossSessionEligibleNodes,
    ...runtime,
    coherentRuns: coherence.completedRuns - coherence.mixedRuntimeRuns
      - coherence.unattributedRuntimeRuns,
    mixedRuntimeRuns: coherence.mixedRuntimeRuns,
    unattributedRuntimeRuns: coherence.unattributedRuntimeRuns,
    ...skills,
    skillEditRate: percent(skills.editedSkills, skills.selectedSkills),
    skillCorrectionResolutionRate: percent(
      skills.skillCorrectionsResolved,
      skills.skillCorrectionsRequired,
    ),
    skillReceiptComplianceRate: percent(
      skills.completeSkillReceipts,
      skills.skillReceiptChecks,
    ),
    promptEvaluations: promptEvaluationCounts.total,
    acceptedPromptEvaluations: promptEvaluationCounts.accepted,
    latestPromptEvaluation: latestPromptEvaluation ? {
      ...latestPromptEvaluation,
      accepted: Boolean(latestPromptEvaluation.accepted),
    } : null,
    comparisons,
    current: latest?.current || null,
    baseline: latest?.baseline || null,
    delta: latest?.delta || null,
  };
}

function empty(): QualitySummary {
  return {
    latestVersion: "", sampleVersion: "", latestReleaseFingerprint: "",
    runs: 0, activeRuns: 0, abandonedRuns: 0, supersededRuns: 0, oldestActiveMinutes: 0,
    progressingActiveRuns: 0, stalledActiveRuns: 0, oldestActiveActivityMinutes: 0,
    completedRate: 0, workflowRate: 0, toolFailures: 0,
    visibilityFailures: 0, workflowBlocks: 0, completionBlocks: 0,
    searchToUseRate: 0, returnedNodes: 0, usedReturnedNodes: 0, rankedUsedReturnedNodes: 0,
    top3UsedReturnedNodes: 0, top3UseRate: 0, maxUsedRank: 0, minimumUsedScorePercent: 0,
    crossSessionReuseRate: 0, crossSessionNodes: 0, observedNodes: 0,
    crossSessionEligibleNodes: 0, crossSessionReusedNodes: 0,
    runtimeObservedCalls: 0, runtimeUnknownCalls: 0, runtimeMismatchCalls: 0,
    coherentRuns: 0, mixedRuntimeRuns: 0, unattributedRuntimeRuns: 0,
    selectedSkills: 0, editedSkills: 0, skillEditRate: 0,
    skillCorrectionsRequired: 0, skillCorrectionsResolved: 0,
    skillCorrectionBlocks: 0, skillCorrectionResolutionRate: 0, comparisons: [],
    skillReceiptChecks: 0, completeSkillReceipts: 0, skillReceiptComplianceRate: 0,
    duplicateSkillReceipts: 0, expectedSkillReceiptSteps: 0, reportedSkillReceiptSteps: 0,
    promptEvaluations: 0, acceptedPromptEvaluations: 0, latestPromptEvaluation: null,
    current: null, baseline: null, delta: null,
  };
}
