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
  abandonedRuns: number;
  supersededRuns: number;
  oldestActiveMinutes: number;
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
  runtimeObservedCalls: number;
  runtimeUnknownCalls: number;
  runtimeMismatchCalls: number;
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
