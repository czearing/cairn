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
  maxDepth: number;
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
  minimumTrials: number;
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
  baselineTokens: number;
  candidateTokens: number;
  tokenReduction: number;
  safeTokenReduction: number | null;
  comparedRuns: number;
  failures: PromptGateFailure[];
}
