import { telemetryDatabase } from "./telemetry-schema";
import type { QualityMetrics, QualitySummary } from "./telemetry-quality-types";
export type { QualityMetrics, QualitySummary } from "./telemetry-quality-types";

const percent = (part: number, total: number): number =>
  total > 0 ? Math.round(part * 1000 / total) / 10 : 0;

function releaseMetrics(
  sinceTs: number, release: string, host: string, model: string
): QualityMetrics | null {
  const db = telemetryDatabase();
  if (!db || !release) return null;
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
    FROM telemetry_runs r WHERE started_ts>=? AND release_fingerprint=? AND host=?
      AND run_class='human' AND status='completed'
      AND model=?`)
    .get(sinceTs, release, host, model) as Omit<QualityMetrics, "release"> | null;
  return row?.runs ? { release, ...row } : null;
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
  const staleCutoff = Date.now()
    - Math.max(60_000, Number(process.env.CAIRN_TELEMETRY_STALE_RUN_MS || "1800000"));
  db.query(`UPDATE telemetry_runs SET ended_ts=?,status='abandoned'
    WHERE status='active' AND COALESCE((
      SELECT MAX(ts) FROM telemetry_events e WHERE e.run_id=telemetry_runs.run_id
    ),started_ts)<?`).run(Date.now(), staleCutoff);
  const runs = db.query(`SELECT
    COALESCE(SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END),0) AS closed,
    COALESCE(SUM(CASE WHEN status='active' THEN 1 ELSE 0 END),0) AS active,
    COALESCE(SUM(CASE WHEN status='abandoned' THEN 1 ELSE 0 END),0) AS abandoned,
    COALESCE(SUM(CASE WHEN status='superseded' THEN 1 ELSE 0 END),0) AS superseded,
    COALESCE(SUM(CASE WHEN status='completed' THEN completed ELSE 0 END),0) AS completed,
    COALESCE(SUM(CASE WHEN status='completed' THEN workflow_passed ELSE 0 END),0) AS workflow,
    COALESCE(SUM(CASE WHEN status='completed' THEN tool_failures ELSE 0 END),0) AS failures,
    COALESCE(MAX(CASE WHEN status='active' THEN (? - started_ts)/60000 ELSE 0 END),0) AS oldestActiveMinutes
    FROM telemetry_runs WHERE started_ts>=? AND run_class='human'`).get(Date.now(), sinceTs) as {
      active: number; closed: number; abandoned: number; superseded: number;
      completed: number; workflow: number; failures: number; oldestActiveMinutes: number;
    };
  const brain = db.query(`WITH returned AS (
      SELECT e.run_id,e.entity_hash,MIN(NULLIF(e.rank,0)) AS rank,
        MAX(e.score_bucket) AS scoreBucket
      FROM telemetry_events e
      JOIN telemetry_runs r USING(run_id)
      WHERE e.ts>=? AND r.status='completed' AND e.kind='brain_returned' AND e.entity_hash!=''
        AND r.run_class='human'
      GROUP BY e.run_id,e.entity_hash
    ), used AS (
      SELECT DISTINCT e.run_id,e.entity_hash FROM telemetry_events e
      JOIN telemetry_runs r USING(run_id)
      WHERE e.ts>=? AND r.status='completed' AND r.run_class='human'
        AND e.kind IN ('brain_referenced','brain_mutated') AND e.entity_hash!=''
    ), observed AS (
      SELECT e.entity_hash,COUNT(DISTINCT e.session_hash) AS sessions FROM telemetry_events e
      JOIN telemetry_runs r USING(run_id)
      WHERE e.ts>=? AND r.status='completed' AND r.run_class='human'
        AND e.entity_type='brain' AND e.entity_hash!=''
      GROUP BY e.entity_hash
    )
    SELECT (SELECT COUNT(*) FROM returned) AS returnedNodes,
      (SELECT COUNT(*) FROM returned r JOIN used u USING(run_id,entity_hash)) AS usedReturnedNodes,
      (SELECT COUNT(*) FROM returned r JOIN used u USING(run_id,entity_hash)
        WHERE r.rank BETWEEN 1 AND 3) AS top3UsedReturnedNodes,
      COALESCE((SELECT MAX(r.rank) FROM returned r JOIN used u USING(run_id,entity_hash)),0) AS maxUsedRank,
      COALESCE((SELECT MIN(NULLIF(r.scoreBucket,0))*5
        FROM returned r JOIN used u USING(run_id,entity_hash)),0) AS minimumUsedScorePercent,
      (SELECT COUNT(*) FROM observed) AS observedNodes,
      (SELECT COUNT(*) FROM observed WHERE sessions>1) AS crossSessionNodes`)
    .get(sinceTs, sinceTs, sinceTs) as {
      returnedNodes: number; usedReturnedNodes: number; top3UsedReturnedNodes: number;
      maxUsedRank: number; minimumUsedScorePercent: number;
      observedNodes: number; crossSessionNodes: number;
    };
  const skills = db.query(`SELECT
    COUNT(DISTINCT CASE WHEN e.kind='skill_selected' THEN e.entity_hash END) AS selectedSkills,
    COUNT(DISTINCT CASE WHEN e.kind='skill_edited' THEN e.entity_hash END) AS editedSkills,
    COALESCE(SUM(CASE WHEN e.kind='visibility_failure' THEN 1 ELSE 0 END),0) AS visibilityFailures,
    COALESCE(SUM(CASE WHEN e.kind='stop_blocked' THEN 1 ELSE 0 END),0) AS workflowBlocks,
    COALESCE(SUM(CASE WHEN e.kind='completion_blocked' THEN 1 ELSE 0 END),0) AS completionBlocks
    FROM telemetry_events e JOIN telemetry_runs r USING(run_id)
    WHERE e.ts>=? AND r.run_class='human' AND r.status='completed'`).get(sinceTs) as {
      selectedSkills: number; editedSkills: number; visibilityFailures: number;
      workflowBlocks: number; completionBlocks: number;
    };
  const runtime = db.query(`SELECT
    COALESCE(SUM(CASE WHEN e.runtime_version!='' THEN 1 ELSE 0 END),0) AS runtimeObservedCalls,
    COALESCE(SUM(CASE WHEN e.runtime_version='' THEN 1 ELSE 0 END),0) AS runtimeUnknownCalls,
    COALESCE(SUM(CASE WHEN e.runtime_version!='' AND e.runtime_version!=r.version
      THEN 1 ELSE 0 END),0) AS runtimeMismatchCalls
    FROM telemetry_events e JOIN telemetry_runs r USING(run_id)
    WHERE e.ts>=? AND r.run_class='human' AND r.status='completed' AND e.kind='tool'
      AND (e.tool_name LIKE 'brain_%' OR e.tool_name LIKE 'skill_%')`).get(sinceTs) as {
        runtimeObservedCalls: number; runtimeUnknownCalls: number; runtimeMismatchCalls: number;
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
  const dimensions = db.query(`SELECT host,model,MAX(started_ts) AS latest
    FROM telemetry_runs WHERE started_ts>=? AND status='completed' AND run_class='human'
    GROUP BY host,model ORDER BY latest DESC`).all(sinceTs) as { host: string; model: string }[];
  const comparisons = dimensions.flatMap(({ host, model }) => {
    const releases = db.query(`SELECT release_fingerprint AS release,MAX(started_ts) AS latest
      FROM telemetry_runs WHERE started_ts>=? AND status='completed' AND run_class='human'
        AND host=? AND model=?
      GROUP BY release_fingerprint ORDER BY latest DESC LIMIT 2`)
      .all(sinceTs, host, model) as { release: string }[];
    const current = releaseMetrics(sinceTs, releases[0]?.release || "", host, model);
    if (!current) return [];
    const baseline = releaseMetrics(sinceTs, releases[1]?.release || "", host, model);
    return [{ host, model, current, baseline, delta: delta(current, baseline) }];
  });
  const latest = comparisons[0];
  return {
    runs: runs.closed,
    activeRuns: runs.active,
    abandonedRuns: runs.abandoned,
    supersededRuns: runs.superseded,
    oldestActiveMinutes: Math.round(runs.oldestActiveMinutes),
    completedRate: percent(runs.completed, runs.closed),
    workflowRate: percent(runs.workflow, runs.closed),
    toolFailures: runs.failures,
    searchToUseRate: percent(brain.usedReturnedNodes, brain.returnedNodes),
    top3UseRate: percent(brain.top3UsedReturnedNodes, brain.usedReturnedNodes),
    ...brain,
    crossSessionReuseRate: percent(brain.crossSessionNodes, brain.observedNodes),
    ...runtime,
    ...skills,
    skillEditRate: percent(skills.editedSkills, skills.selectedSkills),
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
    runs: 0, activeRuns: 0, abandonedRuns: 0, supersededRuns: 0, oldestActiveMinutes: 0,
    completedRate: 0, workflowRate: 0, toolFailures: 0,
    visibilityFailures: 0, workflowBlocks: 0, completionBlocks: 0,
    searchToUseRate: 0, returnedNodes: 0, usedReturnedNodes: 0,
    top3UsedReturnedNodes: 0, top3UseRate: 0, maxUsedRank: 0, minimumUsedScorePercent: 0,
    crossSessionReuseRate: 0, crossSessionNodes: 0, observedNodes: 0,
    runtimeObservedCalls: 0, runtimeUnknownCalls: 0, runtimeMismatchCalls: 0,
    selectedSkills: 0, editedSkills: 0, skillEditRate: 0, comparisons: [],
    promptEvaluations: 0, acceptedPromptEvaluations: 0, latestPromptEvaluation: null,
    current: null, baseline: null, delta: null,
  };
}
