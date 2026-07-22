import { usageSummary } from "./core/usage";
import { c, line } from "./term";

export function printUsageReport(days: number, json = false): void {
  const report = usageSummary(days);
  if (json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  const tokens = (value: number) => Math.round(value).toLocaleString("en-US");
  const contextTokens = report.groups
    .filter((group) => group.eventKind === "context")
    .reduce((total, group) => total + group.estimatedTokens, 0);
  const toolTokens = report.groups
    .filter((group) => group.eventKind === "tool")
    .reduce((total, group) => total + group.estimatedTokens, 0);
  line(c.bold(`Cairn usage · ${days} day${days === 1 ? "" : "s"}`));
  line(
    `~${tokens(report.totals.estimatedTokens)} tokens  ` +
    `context ${tokens(contextTokens)}  tools ${tokens(toolTokens)}  ` +
    `${report.totals.events} events  ${report.totals.failures} failures`
  );
  line();
  line(c.dim("  TOKENS  EVENTS   AVG MS  SOURCE"));
  for (const group of report.groups) {
    const label = [group.host, group.source, group.toolName].filter(Boolean).join(" / ");
    line(
      `${tokens(group.estimatedTokens).padStart(8)}  ${String(group.events).padStart(6)}  ` +
      `${String(group.averageDurationMs).padStart(7)}  ${label}`
    );
  }
}
