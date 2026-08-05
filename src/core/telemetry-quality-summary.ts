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
  // Behavior rates stay scoped to ONE release: that is what lets a fixed outage stop degrading the
  // verdict, and widening the scope would let an old release's failures re-degrade a healthy one.
  // The defect was the sample SIZE, not the scoping — a default minimum of 1 pinned rates to whichever
  // release happened to be newest, so with a release per commit the verdict spoke for a handful of runs
  // while the window held hundreds. Require a release to carry a real sample before it can speak.
  // A minimum sample must never decide WHICH release speaks, only how much confidence to advertise.
  // Requiring 20 runs before a release could carry the rates looked like a quality control, but under a
  // release-per-commit cadence it is unreachable: measured live, only 3 of 19 releases in a 7-day window
  // ever reached 20 and all three were old, so selection fell through to the LARGEST sample and pinned
  // every rate to a stale release — hiding whether the newest fixes worked, which is the one thing the
  // report exists to show. Scoping stays per-release, because that is what lets a fixed outage stop
  // degrading the verdict and stops an old release's failures re-degrading a healthy one. The sliver
  // problem the threshold was meant to solve is a DISCLOSURE problem, so the sample size is reported
  // beside the rates and an explicit issue is raised while the sample is thin.
  const minimumSample = Math.max(1, Number(process.env.CAIRN_TELEMETRY_MIN_SAMPLE || "20"));
  // Prefer the newest release that has a COMPARABLE sample. Selecting on completed runs alone lands
  // on a release whose only runs are release-mismatched, which reports comparable runs 0 and hides a
  // usable older sample; fall back to any completed sample so a brand-new release still reports.
  const comparableSampleVersion = (db.query(`SELECT r.version FROM telemetry_runs r
    WHERE r.started_ts>=? AND r.run_class='human' AND r.status='completed' AND r.version!=''
      AND ${comparableRuntimeSql}
    GROUP BY r.version ORDER BY MAX(r.started_ts) DESC LIMIT 1`)
    .get(sinceTs) as { version?: string } | null)?.version || "";
  const sampleVersion = comparableSampleVersion || (db.query(`SELECT version FROM telemetry_runs
    WHERE started_ts>=? AND run_class='human' AND status='completed' AND version!=''
    GROUP BY version ORDER BY MAX(started_ts) DESC LIMIT 1`)
    .get(sinceTs) as { version?: string } | null)?.version
    || latestVersion;
  // Behavior rates need a SECOND scope, because they have a different cause than runtime health.
  // Runtime health (visibility failures, transport, coherence) is caused by the code, so it must stay
  // scoped to one release: that is what lets shipping a fix clear a fault, and it is the invariant the
  // two reverted widening attempts broke. Brain reuse and receipt compliance are caused by the injected
  // PROMPT, and a release-per-commit cadence resets their sample every time an unrelated file changes.
  // Measured live: 40 releases in 30 days, median 5 completed runs, median release life 24 minutes, so
  // rates spoke for 3 runs out of 219.
  //
  // Pooling by prompt hash is not the recency window that was reverted. That one walked back over
  // releases until the sample was big enough, which re-imported an old release's failures into a
  // healthy one. promptFingerprint is a hash of the injected prompt text, so it is keyed on the CAUSE:
  // change the prompt to fix a behavior and the hash changes, which drops every prior run out of the
  // sample immediately. A fix can still clear its own metric, with no walk-back and no tie-break.
  const comparableBehaviorScope = (db.query(`SELECT r.prompt_hash AS promptHash FROM telemetry_runs r
    WHERE r.started_ts>=? AND r.run_class='human' AND r.status='completed' AND r.prompt_hash!=''
      AND ${comparableRuntimeSql}
    ORDER BY r.started_ts DESC LIMIT 1`)
    .get(sinceTs) as { promptHash?: string } | null)?.promptHash || "";
  const samplePromptHash = comparableBehaviorScope
    || (db.query(`SELECT prompt_hash AS promptHash FROM telemetry_runs
      WHERE started_ts>=? AND run_class='human' AND status='completed' AND prompt_hash!=''
      ORDER BY started_ts DESC LIMIT 1`)
      .get(sinceTs) as { promptHash?: string } | null)?.promptHash || "";
  const behaviorRuns = samplePromptHash
    ? (db.query(`SELECT COUNT(*) AS runs FROM telemetry_runs
        WHERE started_ts>=? AND run_class='human' AND status='completed' AND prompt_hash=?`)
        .get(sinceTs, samplePromptHash) as { runs: number }).runs
    : 0;
  // A scope is only trustworthy next to the population it was drawn from. Report both so a sample of
  // six can never again read as if it were the whole window.
  const populationRuns = (db.query(`SELECT COUNT(*) AS runs FROM telemetry_runs
    WHERE started_ts>=? AND run_class='human' AND status='completed'`)
    .get(sinceTs) as { runs: number }).runs;
  // The sample can fall back to an older release for two very different reasons: the current release
  // has produced nothing yet, or it has produced runs but fewer than the minimum. Report which.
  const latestVersionRuns = latestVersion
    ? (db.query(`SELECT COUNT(*) AS runs FROM telemetry_runs
        WHERE started_ts>=? AND run_class='human' AND status='completed' AND version=?`)
        .get(sinceTs, latestVersion) as { runs: number }).runs
    : 0;
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
        AND r.run_class='human' AND r.prompt_hash=?
      GROUP BY e.run_id,e.entity_hash
    ), used AS (
      SELECT e.run_id,e.entity_hash,e.rowid AS usedRowId FROM telemetry_events e
      JOIN telemetry_runs r USING(run_id)
      WHERE e.ts>=? AND r.status='completed' AND r.run_class='human'
        AND r.prompt_hash=? AND e.kind IN ('brain_referenced','brain_mutated') AND e.entity_hash!=''
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
    .get(sinceTs, samplePromptHash, sinceTs, samplePromptHash) as {
      returnedNodes: number; usedReturnedNodes: number; rankedUsedReturnedNodes: number;
      top3UsedReturnedNodes: number;
      maxUsedRank: number; minimumUsedScorePercent: number;
      crossSessionEligibleNodes: number; crossSessionReusedNodes: number;
    };
  // Enforcement counters stay on the release scope: visibilityFailureRate divides them by the
  // release-scoped run count, and a ratio whose two terms come from different populations is not a
  // rate. Shipping a fix must be able to clear these.
  const skills = db.query(`SELECT
    COALESCE(SUM(CASE WHEN e.kind='visibility_failure' THEN 1 ELSE 0 END),0) AS visibilityFailures,
    COALESCE(SUM(CASE WHEN e.kind='stop_blocked' THEN 1 ELSE 0 END),0) AS workflowBlocks,
    COALESCE(SUM(CASE WHEN e.kind='completion_blocked' THEN 1 ELSE 0 END),0) AS completionBlocks,
    COALESCE(SUM(CASE WHEN e.kind='skill_correction_required' THEN 1 ELSE 0 END),0) AS skillCorrectionsRequired,
    COALESCE(SUM(CASE WHEN e.kind='skill_correction_resolved' THEN 1 ELSE 0 END),0) AS skillCorrectionsResolved,
    COALESCE(SUM(CASE WHEN e.kind='skill_correction_blocked' THEN 1 ELSE 0 END),0) AS skillCorrectionBlocks
    FROM telemetry_events e JOIN telemetry_runs r USING(run_id)
    WHERE e.ts>=? AND r.run_class='human' AND r.status='completed' AND r.version=?`)
    .get(sinceTs, sampleVersion) as {
      visibilityFailures: number;
      workflowBlocks: number; completionBlocks: number;
      skillCorrectionsRequired: number; skillCorrectionsResolved: number;
      skillCorrectionBlocks: number;
    };
  // Skill selection is a raw observation, so it pools by prompt hash. Receipt COMPLIANCE is not an
  // observation, it is a judgement made by the checker code, and a stored judgement is only as good as
  // the code that made it. Pooling those across releases re-imports verdicts from a checker with known
  // defects — 8 of the 9 releases in the current pool scored duplicates with a rule since proven wrong.
  // So receipts are scoped to the newest release that has actually judged one: fixing the checker
  // retires every stale verdict at once, which is the same property release scoping gives runtime health.
  const receiptJudgeVersion = (db.query(`SELECT e.version FROM telemetry_events e
    JOIN telemetry_runs r USING(run_id)
    WHERE e.ts>=? AND r.run_class='human' AND r.status='completed'
      AND e.kind='skill_receipt_checked' AND e.version!=''
    GROUP BY e.version ORDER BY MAX(e.ts) DESC LIMIT 1`)
    .get(sinceTs) as { version?: string } | null)?.version || "";
  const skillBehavior = db.query(`SELECT
    COUNT(DISTINCT CASE WHEN e.kind='skill_selected' AND r.prompt_hash=? THEN e.entity_hash END)
      AS selectedSkills,
    COUNT(DISTINCT CASE WHEN e.kind='skill_edited' AND r.prompt_hash=? THEN e.entity_hash END)
      AS editedSkills,
    COUNT(DISTINCT CASE WHEN e.kind='skill_receipt_checked' AND e.version=? THEN e.run_id END)
      AS receiptRuns,
    COALESCE(SUM(CASE WHEN e.kind='skill_receipt_checked' AND e.version=? THEN 1 ELSE 0 END),0)
      AS skillReceiptChecks,
    COALESCE(SUM(CASE WHEN e.kind='skill_receipt_checked' AND e.version=? AND e.success=1
      THEN 1 ELSE 0 END),0) AS completeSkillReceipts,
    COALESCE(SUM(CASE WHEN e.kind='skill_receipt_duplicate' AND e.version=? THEN 1 ELSE 0 END),0)
      AS duplicateSkillReceipts,
    COALESCE(SUM(CASE WHEN e.kind='skill_receipt_checked' AND e.version=? THEN e.value ELSE 0 END),0)
      AS expectedSkillReceiptSteps,
    COALESCE(SUM(CASE WHEN e.kind='skill_receipt_checked' AND e.version=? THEN e.item_count ELSE 0 END),0)
      AS reportedSkillReceiptSteps
    FROM telemetry_events e JOIN telemetry_runs r USING(run_id)
    WHERE e.ts>=? AND r.run_class='human' AND r.status='completed'`)
    .get(
      samplePromptHash, samplePromptHash, receiptJudgeVersion, receiptJudgeVersion,
      receiptJudgeVersion, receiptJudgeVersion, receiptJudgeVersion, receiptJudgeVersion, sinceTs
    ) as {
      selectedSkills: number; editedSkills: number; receiptRuns: number;
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
    samplePromptHash,
    behaviorRuns,
    populationRuns,
    latestVersionRuns,
    minimumSample,
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
    ...skillBehavior,
    skillEditRate: percent(skillBehavior.editedSkills, skillBehavior.selectedSkills),
    skillCorrectionResolutionRate: percent(
      skills.skillCorrectionsResolved,
      skills.skillCorrectionsRequired,
    ),
    skillReceiptComplianceRate: percent(
      skillBehavior.completeSkillReceipts,
      skillBehavior.skillReceiptChecks,
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
    latestVersion: "", sampleVersion: "", samplePromptHash: "", behaviorRuns: 0, receiptRuns: 0,
    populationRuns: 0, latestVersionRuns: 0,
    minimumSample: 0, latestReleaseFingerprint: "",
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
