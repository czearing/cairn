import { qualityDatabase } from "./quality-schema";

export interface QualityMetrics {
  release: string;
  runs: number;
  completedRate: number;
  workflowRate: number;
  tokensPerRun: number;
  toolFailureRate: number;
  averageStopNudges: number;
}

export interface QualitySummary {
  runs: number;
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

function releaseMetrics(sinceTs: number, release: string): QualityMetrics | null {
  const db = qualityDatabase();
  if (!db || !release) return null;
  const row = db.query(`SELECT COUNT(*) AS runs,
    ROUND(AVG(completed)*100,1) AS completedRate,
    ROUND(AVG(workflow_passed)*100,1) AS workflowRate,
    ROUND(AVG(tool_failures)*100.0/CASE WHEN tool_calls=0 THEN 1 ELSE tool_calls END,1) AS toolFailureRate,
    ROUND(AVG(stop_nudges),1) AS averageStopNudges,
    ROUND(AVG(injected_tokens + COALESCE((
      SELECT SUM(input_tokens+output_tokens) FROM quality_events e WHERE e.run_id=r.run_id
    ),0)),1) AS tokensPerRun
    FROM quality_runs r WHERE started_ts>=? AND release_fingerprint=?`)
    .get(sinceTs, release) as Omit<QualityMetrics, "release"> | null;
  return row?.runs ? { release, ...row } : null;
}

export function qualitySummary(days = 7): QualitySummary {
  const db = qualityDatabase();
  if (!db) return empty();
  const sinceTs = Date.now() - Math.max(1, days) * 86_400_000;
  const runs = db.query(`SELECT COUNT(*) AS runs,
    COALESCE(SUM(completed),0) AS completed,
    COALESCE(SUM(workflow_passed),0) AS workflow,
    COALESCE(SUM(tool_failures),0) AS failures
    FROM quality_runs WHERE started_ts>=?`).get(sinceTs) as {
      runs: number; completed: number; workflow: number; failures: number;
    };
  const brain = db.query(`WITH returned AS (
      SELECT DISTINCT run_id,entity_hash FROM quality_events
      WHERE ts>=? AND kind='brain_returned' AND entity_hash!=''
    ), used AS (
      SELECT DISTINCT run_id,entity_hash FROM quality_events
      WHERE ts>=? AND kind IN ('brain_referenced','brain_mutated') AND entity_hash!=''
    ), observed AS (
      SELECT entity_hash,COUNT(DISTINCT session_hash) AS sessions FROM quality_events
      WHERE ts>=? AND entity_type='brain' AND entity_hash!='' GROUP BY entity_hash
    )
    SELECT (SELECT COUNT(*) FROM returned) AS returnedNodes,
      (SELECT COUNT(*) FROM returned r JOIN used u USING(run_id,entity_hash)) AS usedReturnedNodes,
      (SELECT COUNT(*) FROM observed) AS observedNodes,
      (SELECT COUNT(*) FROM observed WHERE sessions>1) AS crossSessionNodes`)
    .get(sinceTs, sinceTs, sinceTs) as {
      returnedNodes: number; usedReturnedNodes: number; observedNodes: number; crossSessionNodes: number;
    };
  const skills = db.query(`SELECT
    COUNT(DISTINCT CASE WHEN kind='skill_selected' THEN entity_hash END) AS selectedSkills,
    COUNT(DISTINCT CASE WHEN kind='skill_edited' THEN entity_hash END) AS editedSkills,
    COALESCE(SUM(CASE WHEN kind='visibility_failure' THEN 1 ELSE 0 END),0) AS visibilityFailures
    FROM quality_events WHERE ts>=?`).get(sinceTs) as {
      selectedSkills: number; editedSkills: number; visibilityFailures: number;
    };
  const releases = db.query(`SELECT release_fingerprint AS release,MAX(started_ts) AS latest
    FROM quality_runs WHERE started_ts>=? GROUP BY release_fingerprint ORDER BY latest DESC LIMIT 2`)
    .all(sinceTs) as { release: string }[];
  const current = releaseMetrics(sinceTs, releases[0]?.release || "");
  const baseline = releaseMetrics(sinceTs, releases[1]?.release || "");
  return {
    runs: runs.runs,
    completedRate: percent(runs.completed, runs.runs),
    workflowRate: percent(runs.workflow, runs.runs),
    toolFailures: runs.failures,
    searchToUseRate: percent(brain.usedReturnedNodes, brain.returnedNodes),
    ...brain,
    crossSessionReuseRate: percent(brain.crossSessionNodes, brain.observedNodes),
    ...skills,
    skillEditRate: percent(skills.editedSkills, skills.selectedSkills),
    current,
    baseline,
    delta: current && baseline ? {
      tokensPerRun: Math.round((current.tokensPerRun - baseline.tokensPerRun) * 10) / 10,
      completedRate: Math.round((current.completedRate - baseline.completedRate) * 10) / 10,
      workflowRate: Math.round((current.workflowRate - baseline.workflowRate) * 10) / 10,
      toolFailureRate: Math.round((current.toolFailureRate - baseline.toolFailureRate) * 10) / 10,
    } : null,
  };
}

function empty(): QualitySummary {
  return {
    runs: 0, completedRate: 0, workflowRate: 0, toolFailures: 0, visibilityFailures: 0,
    searchToUseRate: 0, returnedNodes: 0, usedReturnedNodes: 0,
    crossSessionReuseRate: 0, crossSessionNodes: 0, observedNodes: 0,
    selectedSkills: 0, editedSkills: 0, skillEditRate: 0,
    current: null, baseline: null, delta: null,
  };
}
