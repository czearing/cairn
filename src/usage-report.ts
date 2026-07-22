import { usageSummary } from "./core/usage";
import { qualitySummary } from "./core/quality-summary";
import { c, line } from "./term";

export function printUsageReport(days: number, json = false): void {
  const report = usageSummary(days);
  const quality = qualitySummary(days);
  if (json) {
    console.log(JSON.stringify({ ...report, quality }, null, 2));
    return;
  }

  const tokens = (value: number) => Math.round(value).toLocaleString("en-US");
  const lagMinutes = Math.round(report.impact.toolTelemetryLagMs / 60_000);
  line(c.bold(`Cairn context impact · ${days} day${days === 1 ? "" : "s"}`));
  line(`fixed/message     ${tokens(report.impact.currentPromptTokens)} tokens`);
  line(`measured/message  ${tokens(report.impact.measuredTokensPerPrompt)} tokens`);
  line(
    `total ${tokens(report.totals.estimatedTokens)}  ` +
    `context ${tokens(report.impact.contextTokens)} (${report.impact.contextPercent}%)  ` +
    `tools ${tokens(report.impact.toolTokens)} (${report.impact.toolPercent}%)`
  );
  line(`${report.impact.prompts} prompts  ${report.totals.events} events  ` +
    `${report.impact.sessions} sessions  ${report.totals.failures} failures`);
  if (lagMinutes > 0) {
    line(c.yellow(`coverage: lower bound · tool telemetry trails context by ${lagMinutes}m`));
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
  line(`runs ${quality.runs} (${quality.activeRuns} active)  completed ${quality.completedRate}%  ` +
    `workflow ${quality.workflowRate}%  tool failures ${quality.toolFailures}`);
  line(`brain search-to-use ${quality.searchToUseRate}% ` +
    `(${quality.usedReturnedNodes}/${quality.returnedNodes})  ` +
    `cross-session reuse ${quality.crossSessionReuseRate}% ` +
    `(${quality.crossSessionNodes}/${quality.observedNodes})`);
  line(`skills selected ${quality.selectedSkills}  edited ${quality.editedSkills} ` +
    `(${quality.skillEditRate}%)  visibility failures ${quality.visibilityFailures}`);
  if (quality.delta) {
    line(`release delta  tokens/run ${signed(quality.delta.tokensPerRun)}  ` +
      `completion ${signed(quality.delta.completedRate)}pp  ` +
      `workflow ${signed(quality.delta.workflowRate)}pp  ` +
      `failures ${signed(quality.delta.toolFailureRate)}pp`);
  } else {
    line(c.dim("release delta  collecting baseline (two release fingerprints required)"));
  }
}

const signed = (value: number): string => `${value > 0 ? "+" : ""}${value}`;
