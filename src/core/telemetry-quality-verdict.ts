import type { EngineSummary } from "./telemetry-engine-summary";
import type { QualitySummary } from "./telemetry-quality-types";

interface QualityVerdict {
  status: "healthy" | "degraded" | "outage" | "insufficient_data";
  releaseCoherent: boolean;
  issues: string[];
  behavior: {
    runs: number;
    completedRate: number;
    workflowRate: number;
    visibilityFailures: number;
    visibilityFailureRate: number;
    searchToUseRate: number;
    skillCorrectionResolutionRate: number;
    skillReceiptComplianceRate: number;
    stalledActiveRuns: number;
  };
  infrastructure: {
    version: string;
    transportCalls: number;
    transportFailures: number;
    daemonCalls: number;
    fallbackCalls: number;
    parityChecks: number;
    parityMismatches: number;
  };
}

const percent = (part: number, total: number): number =>
  total > 0 ? Math.round(part * 1000 / total) / 10 : 0;

export function telemetryQualityVerdict(
  behavior: QualitySummary,
  engine: EngineSummary,
): QualityVerdict {
  const transportCalls = engine.engineTransports.reduce((sum, row) => sum + row.calls, 0);
  const transportFailures = engine.engineTransports.reduce((sum, row) => sum + row.failures, 0);
  const daemonCalls = engine.engineTransports
    .filter((row) => row.source === "daemon")
    .reduce((sum, row) => sum + row.calls, 0);
  const fallbackCalls = engine.engineTransports
    .filter((row) => row.source === "fallback")
    .reduce((sum, row) => sum + row.calls, 0);
  const visibilityFailureRate = percent(behavior.visibilityFailures, behavior.runs);
  const releaseCoherent = Boolean(
    behavior.latestVersion
    && engine.version
    && behavior.latestVersion === engine.version
  );
  const issues: string[] = [];

  if (!behavior.runs) issues.push("No completed human behavior samples.");
  if (behavior.sampleVersion && behavior.latestVersion && behavior.sampleVersion !== behavior.latestVersion) {
    issues.push(
      behavior.latestVersionRuns
        ? `Behavior rates are from ${behavior.sampleVersion}; current release ${behavior.latestVersion} has only ${behavior.latestVersionRuns} completed run(s), below the ${behavior.minimumSample} needed to report.`
        : `Behavior rates are from ${behavior.sampleVersion}; current release ${behavior.latestVersion} has no completed runs yet.`
    );
  } else if (behavior.populationRuns > behavior.runs * 4 && behavior.runs) {
    issues.push(
      `Behavior rates cover ${behavior.runs} of ${behavior.populationRuns} completed runs in the window; releases are too fragmented to sample.`
    );
  }
  if (behavior.runs && visibilityFailureRate > 0) {
    issues.push(
      `Cairn tools were invisible in ${behavior.visibilityFailures}/${behavior.runs} completed human runs.`
    );
  }
  if (behavior.runs && behavior.workflowRate < 100) {
    issues.push(`Only ${behavior.workflowRate}% of completed human runs passed the Cairn workflow.`);
  }
  if (behavior.stalledActiveRuns) {
    issues.push(`${behavior.stalledActiveRuns}/${behavior.activeRuns} active human runs are stalled.`);
  }
  if (behavior.runs && behavior.skillReceiptChecks < behavior.runs) {
    issues.push(
      `Skill receipts were verified for ${behavior.skillReceiptChecks}/${behavior.runs} completed human runs.`
    );
  } else if (behavior.skillReceiptChecks && behavior.skillReceiptComplianceRate < 100) {
    issues.push(
      `Only ${behavior.skillReceiptComplianceRate}% of checked final responses had complete skill receipts.`
    );
  }
  if (behavior.duplicateSkillReceipts) {
    issues.push(`${behavior.duplicateSkillReceipts} final responses contained duplicate Cairn receipts.`);
  }
  const coherenceTotal = behavior.coherentRuns + behavior.mixedRuntimeRuns
    + behavior.unattributedRuntimeRuns;
  if (behavior.mixedRuntimeRuns) {
    issues.push(
      `${behavior.mixedRuntimeRuns}/${coherenceTotal} completed human runs are excluded from release ` +
      "comparisons because the hook and runtime releases differed mid-session."
    );
  }
  if (behavior.unattributedRuntimeRuns) {
    issues.push(
      `${behavior.unattributedRuntimeRuns}/${coherenceTotal} completed human runs report no runtime ` +
      "release, so they cannot be attributed to a release rather than being known to differ."
    );
  }
  if (!engine.version) issues.push("No infrastructure-health sample is available.");
  if (transportFailures) issues.push(`${transportFailures}/${transportCalls} engine transports failed.`);
  if (fallbackCalls) issues.push(`${fallbackCalls}/${transportCalls} engine calls used direct fallback.`);
  if (engine.parity.mismatches) {
    issues.push(`${engine.parity.mismatches}/${engine.parity.checks} engine parity checks mismatched.`);
  }
  if (behavior.latestVersion && engine.version && !releaseCoherent) {
    issues.push(
      `Behavior (${behavior.latestVersion}) and infrastructure (${engine.version}) are from different releases.`
    );
  }

  let status: QualityVerdict["status"] = "healthy";
  if (!behavior.runs || !engine.version) status = "insufficient_data";
  if (issues.length && status === "healthy") status = "degraded";
  if (
    behavior.visibilityFailures > 0
    || (behavior.runs >= 3 && behavior.workflowRate === 0)
  ) {
    status = "outage";
  }

  return {
    status,
    releaseCoherent,
    issues,
    behavior: {
      runs: behavior.runs,
      completedRate: behavior.completedRate,
      workflowRate: behavior.workflowRate,
      visibilityFailures: behavior.visibilityFailures,
      visibilityFailureRate,
      searchToUseRate: behavior.searchToUseRate,
      skillCorrectionResolutionRate: behavior.skillCorrectionResolutionRate,
      skillReceiptComplianceRate: behavior.skillReceiptComplianceRate,
      stalledActiveRuns: behavior.stalledActiveRuns,
    },
    infrastructure: {
      version: engine.version,
      transportCalls,
      transportFailures,
      daemonCalls,
      fallbackCalls,
      parityChecks: engine.parity.checks,
      parityMismatches: engine.parity.mismatches,
    },
  };
}
