export interface QualityMetrics {
  release: string;
  workload: "small" | "medium" | "large";
  runs: number;
  /** Completed runs in this dimension dropped from the comparison for mixed hook/runtime releases. */
  excludedRuns: number;
  unattributedRuns: number;
  completedRate: number;
  workflowRate: number;
  tokensPerRun: number;
  toolFailureRate: number;
  averageStopNudges: number;
}

interface ReleaseComparison {
  host: string;
  model: string;
  workload: QualityMetrics["workload"];
  current: QualityMetrics;
  baseline: QualityMetrics | null;
  delta: QualitySummary["delta"];
}

export interface QualitySummary {
  latestVersion: string;
  /** Newest release with a completed sample; it labels the behavior scope. */
  sampleVersion: string;
  /** Completed human runs in the window, regardless of release; the population `runs` is drawn from. */
  populationRuns: number;
  latestReleaseFingerprint: string;
  runs: number;
  activeRuns: number;
  abandonedRuns: number;
  supersededRuns: number;
  oldestActiveMinutes: number;
  progressingActiveRuns: number;
  stalledActiveRuns: number;
  oldestActiveActivityMinutes: number;
  completedRate: number;
  workflowRate: number;
  toolFailures: number;
  visibilityFailures: number;
  workflowBlocks: number;
  completionBlocks: number;
  searchToUseRate: number;
  returnedNodes: number;
  usedReturnedNodes: number;
  rankedUsedReturnedNodes: number;
  top3UsedReturnedNodes: number;
  top3UseRate: number;
  maxUsedRank: number;
  minimumUsedScorePercent: number;
  crossSessionReuseRate: number;
  crossSessionNodes: number;
  observedNodes: number;
  crossSessionEligibleNodes: number;
  crossSessionReusedNodes: number;
  runtimeObservedCalls: number;
  runtimeUnknownCalls: number;
  runtimeMismatchCalls: number;
  coherentRuns: number;
  mixedRuntimeRuns: number;
  unattributedRuntimeRuns: number;
  selectedSkills: number;
  editedSkills: number;
  skillEditRate: number;
  skillCorrectionsRequired: number;
  skillCorrectionsResolved: number;
  skillCorrectionBlocks: number;
  skillCorrectionResolutionRate: number;
  skillReceiptChecks: number;
  completeSkillReceipts: number;
  skillReceiptComplianceRate: number;
  duplicateSkillReceipts: number;
  expectedSkillReceiptSteps: number;
  reportedSkillReceiptSteps: number;
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
