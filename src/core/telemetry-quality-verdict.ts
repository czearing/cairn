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
        ? `Behavior rates are from ${behavior.sampleVersion}; current release ${behavior.latestVersion} has ${behavior.latestVersionRuns} completed run(s), none with comparable release attribution.`
        : `Behavior rates are from ${behavior.sampleVersion}; current release ${behavior.latestVersion} has no completed runs yet.`
    );
  }
  // A thin sample is a confidence caveat, not a reason to report someone else's release. Say so.
  // Prompt-driven rates are drawn from the prompt scope, so the disclosure must count THAT sample,
  // not the release-scoped run count they are no longer computed from.
  const thinSample = Boolean(behavior.behaviorRuns && behavior.behaviorRuns < behavior.minimumSample);
  const thinSampleIssue = thinSample
    ? `Behavior rates cover ${behavior.behaviorRuns} completed run(s) of ${behavior.populationRuns} in the `
      + `window, below the ${behavior.minimumSample} wanted for a stable rate.`
    : "";
  if (thinSampleIssue) issues.push(thinSampleIssue);
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
  if (behavior.receiptRuns && behavior.skillReceiptChecks < behavior.receiptRuns) {
    issues.push(
      `Skill receipts were verified for ${behavior.skillReceiptChecks}/${behavior.receiptRuns} completed human runs.`
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
  // A sample too small to trust is missing evidence, not a fault. Reporting DEGRADED for it implied a
  // breakage that did not exist, and because every release rolls the fingerprint the sample is thin far
  // more often than not, so the banner said DEGRADED almost permanently and stopped carrying meaning.
  // Only real findings degrade; when the thin sample is the sole issue, say the data is insufficient.
  const faults = thinSampleIssue ? issues.filter((issue) => issue !== thinSampleIssue) : issues;
  if (status === "healthy") {
    if (faults.length) status = "degraded";
    else if (thinSample) status = "insufficient_data";
  }
  // Rates are already scoped to the newest release, so a fixed fault stops counting as soon as the next
  // release produces runs. Within that scope the trigger is a RATE: a single stray visibility failure in
  // an otherwise healthy sample is a degradation, not a total outage, and an absolute count let one
  // transient glitch hold the banner at OUTAGE for as long as that release kept supplying the sample.
  const outageVisibilityRate = Math.max(
    1, Number(process.env.CAIRN_OUTAGE_VISIBILITY_RATE || "25")
  );
  if (
    (behavior.runs && visibilityFailureRate >= outageVisibilityRate)
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
