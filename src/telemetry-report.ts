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
  line(`completed runs ${quality.runs}  active ${quality.activeRuns}` +
    `${quality.oldestActiveMinutes ? ` (oldest ${quality.oldestActiveMinutes}m)` : ""}  ` +
    `abandoned ${quality.abandonedRuns}  superseded ${quality.supersededRuns}`);
  line(`completed ${quality.completedRate}%  ` +
    `workflow ${quality.workflowRate}%  tool failures ${quality.toolFailures}`);
  line(`brain search-to-use ${quality.searchToUseRate}% ` +
    `(${quality.usedReturnedNodes}/${quality.returnedNodes})  ` +
    `top-3 use ${quality.top3UseRate}% (${quality.top3UsedReturnedNodes}/` +
    `${quality.rankedUsedReturnedNodes} ranked)  max used rank ${quality.maxUsedRank}  ` +
    `lowest used score ~${quality.minimumUsedScorePercent}%`);
  line(
    `cross-session reuse ${quality.crossSessionReuseRate}% ` +
    `(${quality.crossSessionNodes}/${quality.observedNodes})  ` +
    `runtime observed ${quality.runtimeObservedCalls}  unknown ${quality.runtimeUnknownCalls}  ` +
    `mismatch ${quality.runtimeMismatchCalls}`
  );
  line(`skills selected ${quality.selectedSkills}  edited ${quality.editedSkills} ` +
    `(${quality.skillEditRate}%)  visibility failures ${quality.visibilityFailures}`);
  line(`workflow blocks ${quality.workflowBlocks}  completion blocks ${quality.completionBlocks}`);
  line(`prompt evals ${quality.promptEvaluations}  accepted ${quality.acceptedPromptEvaluations}` +
    (quality.latestPromptEvaluation
      ? `  latest quality +${quality.latestPromptEvaluation.qualityImprovements}` +
        `/${quality.latestPromptEvaluation.qualityChecks}`
      : ""));
  const deltas = quality.comparisons.filter((item) => item.delta);
  for (const item of deltas) {
    line(`${item.host}${item.model ? `/${item.model}` : ""} release delta  ` +
      `tokens/run ${signed(item.delta!.tokensPerRun)}  ` +
      `completion ${signed(item.delta!.completedRate)}pp  ` +
      `workflow ${signed(item.delta!.workflowRate)}pp  ` +
      `failures ${signed(item.delta!.toolFailureRate)}pp`);
  }
  if (!deltas.length) {
    line(c.dim("release delta  collecting baseline (two release fingerprints required)"));
  }
}

const signed = (value: number): string => `${value > 0 ? "+" : ""}${value}`;
