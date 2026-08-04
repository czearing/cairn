import { telemetrySummary } from "./core/telemetry";
import { c, line } from "./term";

export function printTelemetryReport(days: number, json = false): void {
  const report = telemetrySummary(days);
  const quality = report.quality;
  if (json) {
    console.log(JSON.stringify({ ...report, quality }, null, 2));
    return;
  }

  const tokens = (value: number) => Math.round(value).toLocaleString("en-US");
  line(c.bold(`Cairn context impact · ${days} day${days === 1 ? "" : "s"}`));
  line(`release ${report.impact.version} ${report.impact.releaseFingerprint} · ${report.impact.runClass}`);
  line(`fixed/message     ${tokens(report.impact.currentPromptTokens)} tokens`);
  line(`measured/message  ${tokens(report.impact.measuredTokensPerPrompt)} tokens`);
  line(
    `total ${tokens(report.totals.estimatedTokens)}  ` +
    `context ${tokens(report.impact.contextTokens)} (${report.impact.contextPercent}%)  ` +
    `tools ${tokens(report.impact.toolTokens)} (${report.impact.toolPercent}%)`
  );
  line(`${report.impact.prompts} prompts  ${report.totals.events} events  ` +
    `${report.impact.sessions} sessions  ${report.totals.failures} failures`);
  line(`MCP ${report.engine.toolSchemas.version || report.engine.version || "runtime"} schemas  ` +
    `${tokens(report.engine.toolSchemas.estimatedTokens)} tokens  ` +
    `${tokens(report.engine.toolSchemas.chars)} chars  ${report.engine.toolSchemas.tools} tools`);
  for (const stage of report.engine.searchStages) {
    line(`search/${stage.stage}  avg ${stage.averageDurationMs}ms  ` +
      `max ${stage.maximumDurationMs}ms  ${stage.events} calls`);
  }
  for (const transport of report.engine.engineTransports) {
    line(`engine/${transport.source}/${transport.operation}  avg ${transport.averageDurationMs}ms  ` +
      `max ${transport.maximumDurationMs}ms  ${transport.calls} calls  ${transport.failures} failures`);
  }
  if (report.engine.parity.checks) {
    line(`engine parity      ${report.engine.parity.checks} checks  ` +
      `${report.engine.parity.mismatches} mismatches`);
  }
  line();
  line(c.dim("   TOTAL     AVG       RANGE  CALLS  SURFACE"));
  for (const group of report.groups) {
    const label = [group.host, group.source, group.toolName].filter(Boolean).join(" / ");
    line(
      `${tokens(group.estimatedTokens).padStart(8)}  ` +
      `${tokens(group.estimatedTokens / group.events).padStart(6)}  ` +
      `${`${tokens(group.minimumTokens)}-${tokens(group.maximumTokens)}`.padStart(10)}  ` +
      `${String(group.events).padStart(5)}  ${label}`
    );
  }
  line();
  line(c.bold("Quality & reuse"));
  line(`completed runs ${quality.runs}` +
    `${quality.populationRuns > quality.runs ? ` of ${quality.populationRuns} in window` : ""}` +
    `  active ${quality.activeRuns}` +
    `${quality.oldestActiveMinutes ? ` (oldest ${quality.oldestActiveMinutes}m)` : ""}  ` +
    `progressing ${quality.progressingActiveRuns}  stalled ${quality.stalledActiveRuns}  ` +
    `abandoned ${quality.abandonedRuns}  superseded ${quality.supersededRuns}`);
  // "INSUFFICIENT_DATA" reads like a fault to anyone who is not holding the enum. Print what it means.
  const statusLabel = quality.verdict.status === "insufficient_data"
    ? "NOT ENOUGH DATA"
    : quality.verdict.status.toUpperCase();
  line(`quality status ${statusLabel}  ` +
    `release coherent ${quality.verdict.releaseCoherent ? "yes" : "no"}`);
  for (const issue of quality.verdict.issues) line(`  ! ${issue}`);
  line(`completed ${quality.completedRate}%  ` +
    `workflow ${quality.workflowRate}%  tool failures ${quality.toolFailures}`);
  line(`brain search-to-use ${quality.searchToUseRate}% ` +
    `(${quality.usedReturnedNodes}/${quality.returnedNodes})  ` +
    `top-3 use ${quality.top3UseRate}% (${quality.top3UsedReturnedNodes}/` +
    `${quality.rankedUsedReturnedNodes} ranked)  max used rank ${quality.maxUsedRank}  ` +
    `lowest used score ~${quality.minimumUsedScorePercent}%`);
  line(
    `cross-session reuse (eligible recalled-use) ${quality.crossSessionReuseRate}% ` +
    `(${quality.crossSessionReusedNodes}/${quality.crossSessionEligibleNodes})  ` +
    `runtime observed ${quality.runtimeObservedCalls}  unknown ${quality.runtimeUnknownCalls}  ` +
    `mismatch ${quality.runtimeMismatchCalls}`
  );
  line(`release coherence  comparable runs ${quality.coherentRuns}  ` +
    `excluded (mixed hook/runtime release) ${quality.mixedRuntimeRuns}  ` +
    `unattributed runtime ${quality.unattributedRuntimeRuns}`);
  line(`skills selected ${quality.selectedSkills}  edited ${quality.editedSkills} ` +
    `(${quality.skillEditRate}%)  visibility failures ${quality.visibilityFailures}`);
  line(`skill corrections required ${quality.skillCorrectionsRequired}  ` +
    `resolved ${quality.skillCorrectionsResolved} (${quality.skillCorrectionResolutionRate}%)  ` +
    `blocks ${quality.skillCorrectionBlocks}`);
  line(`skill receipts ${quality.completeSkillReceipts}/${quality.skillReceiptChecks} complete ` +
    `(${quality.skillReceiptComplianceRate}%)  duplicate ${quality.duplicateSkillReceipts}  ` +
    `steps ${quality.reportedSkillReceiptSteps}/${quality.expectedSkillReceiptSteps}`);
  line(`workflow blocks ${quality.workflowBlocks}  completion blocks ${quality.completionBlocks}`);
  line(`prompt evals ${quality.promptEvaluations}  accepted ${quality.acceptedPromptEvaluations}` +
    (quality.latestPromptEvaluation
      ? `  latest quality +${quality.latestPromptEvaluation.qualityImprovements}` +
        `/${quality.latestPromptEvaluation.qualityChecks}`
      : ""));
  const deltas = quality.comparisons.filter((item) => item.delta);
  for (const item of deltas) {
    const excluded = item.current.excludedRuns + (item.baseline?.excludedRuns ?? 0);
    const unattributed = item.current.unattributedRuns + (item.baseline?.unattributedRuns ?? 0);
    line(`${item.host}/${item.model}/${item.workload} release delta  ` +
      `tokens/run ${signed(item.delta!.tokensPerRun)}  ` +
      `completion ${signed(item.delta!.completedRate)}pp  ` +
      `workflow ${signed(item.delta!.workflowRate)}pp  ` +
      `failures ${signed(item.delta!.toolFailureRate)}pp` +
      (excluded ? `  (${excluded} run(s) excluded for mixed runtime)` : "") +
      (unattributed ? `  (${unattributed} run(s) unattributed)` : ""));
  }
  if (!deltas.length) {
    line(c.dim("release delta  collecting baseline (two release fingerprints required)"));
    if (quality.mixedRuntimeRuns) {
      line(c.dim(`release delta  ${quality.mixedRuntimeRuns} completed run(s) are excluded ` +
        "because the hook and runtime releases differed mid-session"));
    }
    if (quality.unattributedRuntimeRuns) {
      line(c.dim(`release delta  ${quality.unattributedRuntimeRuns} completed run(s) report no ` +
        "runtime release and cannot be attributed"));
    }
  }
}

const signed = (value: number): string => `${value > 0 ? "+" : ""}${value}`;
