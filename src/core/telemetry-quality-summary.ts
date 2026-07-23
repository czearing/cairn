import { telemetryDatabase } from "./telemetry-schema";

export interface QualityMetrics {
  release: string;
  runs: number;
  completedRate: number;
  workflowRate: number;
  tokensPerRun: number;
  toolFailureRate: number;
  averageStopNudges: number;
}

export interface ReleaseComparison {
  host: string;
  model: string;
  current: QualityMetrics;
  baseline: QualityMetrics | null;
  delta: QualitySummary["delta"];
}

export interface QualitySummary {
  runs: number;
  activeRuns: number;
  completedRate: number;
  workflowRate: number;
  toolFailures: number;
  visibilityFailures: number;
  searchToUseRate: number;
  returnedNodes: number;
  usedReturnedNodes: number;
  crossSessionReuseRate: number;
  crossSessionNodes: number;
  observedNodes: number;
  selectedSkills: number;
  editedSkills: number;
  skillEditRate: number;
  promptEvaluations: number;
  acceptedPromptEvaluations: number;
  latestPromptEvaluation: {
    candidatePromptHash: string;
    accepted: boolean;
    tokenReduction: number;
    safeTokenReduction: number | null;
    qualityImprovements: number;
    qualityChecks: number;
    comparedRuns: number;
  } | null;
  comparisons: ReleaseComparison[];
  current: QualityMetrics | null;
  baseline: QualityMetrics | null;
  delta: {
    tokensPerRun: number;
    completedRate: number;
    workflowRate: number;
    toolFailureRate: number;
  } | null;
}

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
    ),0)),1) AS tokensPerRun
    FROM telemetry_runs r WHERE started_ts>=? AND release_fingerprint=? AND host=?
      AND run_class='human'
      AND model=? AND ended_ts>0`)
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
  const runs = db.query(`SELECT COUNT(*) AS runs,
    COALESCE(SUM(CASE WHEN ended_ts=0 THEN 1 ELSE 0 END),0) AS active,
    COALESCE(SUM(CASE WHEN ended_ts>0 THEN 1 ELSE 0 END),0) AS closed,
    COALESCE(SUM(completed),0) AS completed,
    COALESCE(SUM(workflow_passed),0) AS workflow,
    COALESCE(SUM(tool_failures),0) AS failures
    FROM telemetry_runs WHERE started_ts>=? AND run_class='human'`).get(sinceTs) as {
      runs: number; active: number; closed: number; completed: number; workflow: number; failures: number;
    };
  const brain = db.query(`WITH returned AS (
      SELECT DISTINCT e.run_id,e.entity_hash FROM telemetry_events e
      JOIN telemetry_runs r USING(run_id)
      WHERE e.ts>=? AND r.ended_ts>0 AND e.kind='brain_returned' AND e.entity_hash!=''
        AND r.run_class='human'
    ), used AS (
      SELECT DISTINCT e.run_id,e.entity_hash FROM telemetry_events e
      JOIN telemetry_runs r USING(run_id)
      WHERE e.ts>=? AND r.ended_ts>0 AND r.run_class='human'
        AND e.kind IN ('brain_referenced','brain_mutated') AND e.entity_hash!=''
    ), observed AS (
      SELECT e.entity_hash,COUNT(DISTINCT e.session_hash) AS sessions FROM telemetry_events e
      JOIN telemetry_runs r USING(run_id)
      WHERE e.ts>=? AND r.ended_ts>0 AND r.run_class='human'
        AND e.entity_type='brain' AND e.entity_hash!=''
      GROUP BY e.entity_hash
    )
    SELECT (SELECT COUNT(*) FROM returned) AS returnedNodes,
      (SELECT COUNT(*) FROM returned r JOIN used u USING(run_id,entity_hash)) AS usedReturnedNodes,
      (SELECT COUNT(*) FROM observed) AS observedNodes,
      (SELECT COUNT(*) FROM observed WHERE sessions>1) AS crossSessionNodes`)
    .get(sinceTs, sinceTs, sinceTs) as {
      returnedNodes: number; usedReturnedNodes: number; observedNodes: number; crossSessionNodes: number;
    };
  const skills = db.query(`SELECT
    COUNT(DISTINCT CASE WHEN r.ended_ts>0 AND e.kind='skill_selected' THEN e.entity_hash END) AS selectedSkills,
    COUNT(DISTINCT CASE WHEN r.ended_ts>0 AND e.kind='skill_edited' THEN e.entity_hash END) AS editedSkills,
    COALESCE(SUM(CASE WHEN e.kind='visibility_failure' THEN 1 ELSE 0 END),0) AS visibilityFailures
    FROM telemetry_events e JOIN telemetry_runs r USING(run_id)
    WHERE e.ts>=? AND r.run_class='human'`).get(sinceTs) as {
      selectedSkills: number; editedSkills: number; visibilityFailures: number;
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
    FROM telemetry_runs WHERE started_ts>=? AND ended_ts>0 AND run_class='human'
    GROUP BY host,model ORDER BY latest DESC`).all(sinceTs) as { host: string; model: string }[];
  const comparisons = dimensions.flatMap(({ host, model }) => {
    const releases = db.query(`SELECT release_fingerprint AS release,MAX(started_ts) AS latest
      FROM telemetry_runs WHERE started_ts>=? AND ended_ts>0 AND run_class='human'
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
    runs: runs.runs,
    activeRuns: runs.active,
    completedRate: percent(runs.completed, runs.closed),
    workflowRate: percent(runs.workflow, runs.closed),
    toolFailures: runs.failures,
    searchToUseRate: percent(brain.usedReturnedNodes, brain.returnedNodes),
    ...brain,
    crossSessionReuseRate: percent(brain.crossSessionNodes, brain.observedNodes),
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
    runs: 0, activeRuns: 0, completedRate: 0, workflowRate: 0, toolFailures: 0, visibilityFailures: 0,
    searchToUseRate: 0, returnedNodes: 0, usedReturnedNodes: 0,
    crossSessionReuseRate: 0, crossSessionNodes: 0, observedNodes: 0,
    selectedSkills: 0, editedSkills: 0, skillEditRate: 0, comparisons: [],
    promptEvaluations: 0, acceptedPromptEvaluations: 0, latestPromptEvaluation: null,
    current: null, baseline: null, delta: null,
  };
}
