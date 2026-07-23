export type PromptHost = "copilot" | "claude";

export interface PromptRunEvidence {
  caseId: string;
  host: PromptHost;
  trial: number;
  promptTokens: number;
  completed: boolean;
  workflowPassed: boolean;
  skillSelected: boolean;
  selectedSkillIds: string[];
  brainSearched: boolean;
  searchBeforeWrite: boolean;
  rootCreated: boolean;
  rootSynthesized: boolean;
  rootSynthesizedLast: boolean;
  createdNodes: number;
  answeredNodes: number;
  citedAnswers: number;
  deepestLevel: number;
  returnedNodes: number;
  usedReturnedNodes: number;
  taskAssertionSet: string;
  taskAssertionsPassed: number;
  taskAssertionsTotal: number;
  toolFailures: number;
  stopNudges: number;
  unexpectedEvents: number;
}

export interface PromptBenchmark {
  name: string;
  promptHash: string;
  minimumTrials: number;
  requireQualityImprovement: boolean;
  runs: PromptRunEvidence[];
}

export interface PromptGateFailure {
  caseId: string;
  host: PromptHost;
  trial: number;
  gate: string;
  baseline: number | boolean | string;
  candidate: number | boolean | string;
}

export interface PromptEvaluation {
  accepted: boolean;
  baselinePromptHash: string;
  candidatePromptHash: string;
  qualityDefinitionHash: string;
  baselineTokens: number;
  candidateTokens: number;
  tokenReduction: number;
  safeTokenReduction: number | null;
  qualityImprovements: number;
  qualityChecks: number;
  comparedRuns: number;
  failures: PromptGateFailure[];
}
