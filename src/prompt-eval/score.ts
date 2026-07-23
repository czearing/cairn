import type {
  PromptBenchmark,
  PromptEvaluation,
  PromptGateFailure,
  PromptRunEvidence,
} from "./types";
import {
  compareRun,
  definitionHash,
  qualityGains,
  ratio,
} from "./quality-gates";

const key = (run: PromptRunEvidence): string =>
  `${run.host}\0${run.caseId}\0${run.trial}`;
const rounded = (value: number): number => Math.round(value * 1000) / 1000;

export function evaluatePrompt(
  baseline: PromptBenchmark,
  candidate: PromptBenchmark,
): PromptEvaluation {
  const candidates = new Map(candidate.runs.map((run) => [key(run), run]));
  const failures: PromptGateFailure[] = [];
  const baselineDefinitionHash = definitionHash(baseline.runs);
  const candidateDefinitionHash = definitionHash(candidate.runs);
  const matched: Array<[PromptRunEvidence, PromptRunEvidence]> = [];
  let qualityImprovements = 0;
  let qualityChecks = 0;
  const first = baseline.runs[0]!;
  const configFailure = (
    gate: string,
    expected: number | boolean | string,
    actual: number | boolean | string,
  ) => failures.push({
    caseId: first.caseId,
    host: first.host,
    trial: first.trial,
    gate,
    baseline: expected,
    candidate: actual,
  });
  if (candidateDefinitionHash !== baselineDefinitionHash) {
    configFailure("qualityDefinition", baselineDefinitionHash, candidateDefinitionHash);
  }
  if (candidate.minimumTrials !== baseline.minimumTrials) {
    configFailure("minimumTrialsConfig", baseline.minimumTrials, candidate.minimumTrials);
  }
  if (candidate.requireQualityImprovement !== baseline.requireQualityImprovement) {
    configFailure(
      "requireQualityImprovementConfig",
      baseline.requireQualityImprovement,
      candidate.requireQualityImprovement,
    );
  }
  const trialCounts = new Map<string, number>();
  for (const run of baseline.runs) {
    const group = `${run.host}\0${run.caseId}`;
    trialCounts.set(group, (trialCounts.get(group) || 0) + 1);
  }
  for (const [group, count] of trialCounts) {
    if (count >= baseline.minimumTrials) continue;
    const [host, caseId] = group.split("\0") as [PromptRunEvidence["host"], string];
    failures.push({
      caseId, host, trial: 0, gate: "minimumTrials",
      baseline: baseline.minimumTrials, candidate: count,
    });
  }
  for (const run of baseline.runs) {
    const found = candidates.get(key(run));
    if (!found) {
      failures.push({
        caseId: run.caseId, host: run.host, trial: run.trial,
        gate: "runPresent", baseline: true, candidate: false,
      });
      continue;
    }
    const quality = qualityGains(run, found);
    matched.push([run, found]);
    qualityImprovements += quality.gains;
    qualityChecks += quality.checks;
    failures.push(...compareRun(run, found));
    candidates.delete(key(run));
  }
  for (const extra of candidates.values()) {
    failures.push({
      caseId: extra.caseId, host: extra.host, trial: extra.trial,
      gate: "unexpectedRun", baseline: false, candidate: true,
    });
  }
  compareReuse(matched, failures);
  if (baseline.requireQualityImprovement && qualityImprovements === 0) {
    configFailure("qualityImprovements", "at least one", 0);
  }
  const baselineTokens = baseline.runs.reduce((sum, run) => sum + run.promptTokens, 0);
  const candidateTokens = candidate.runs.reduce((sum, run) => sum + run.promptTokens, 0);
  const tokenReduction = baselineTokens
    ? rounded(1 - candidateTokens / baselineTokens)
    : 0;
  if (candidateTokens >= baselineTokens) {
    configFailure("tokenReduction", "greater than zero", tokenReduction);
  }
  return {
    accepted: failures.length === 0,
    baselinePromptHash: baseline.promptHash,
    candidatePromptHash: candidate.promptHash,
    qualityDefinitionHash: baselineDefinitionHash,
    baselineTokens,
    candidateTokens,
    tokenReduction,
    safeTokenReduction: failures.length ? null : tokenReduction,
    qualityImprovements,
    qualityChecks,
    comparedRuns: baseline.runs.length,
    failures,
  };
}

function compareReuse(
  matched: Array<[PromptRunEvidence, PromptRunEvidence]>,
  failures: PromptGateFailure[],
): void {
  const groups = new Map<string, {
    baselineReturned: number;
    baselineUsed: number;
    candidateReturned: number;
    candidateUsed: number;
    run: PromptRunEvidence;
  }>();
  for (const [baseline, candidate] of matched) {
    const group = `${baseline.host}\0${baseline.caseId}`;
    const values = groups.get(group) || {
      baselineReturned: 0,
      baselineUsed: 0,
      candidateReturned: 0,
      candidateUsed: 0,
      run: candidate,
    };
    values.baselineReturned += baseline.returnedNodes;
    values.baselineUsed += baseline.usedReturnedNodes;
    values.candidateReturned += candidate.returnedNodes;
    values.candidateUsed += candidate.usedReturnedNodes;
    groups.set(group, values);
  }
  for (const values of groups.values()) {
    const baseline = ratio(values.baselineUsed, values.baselineReturned);
    const candidate = ratio(values.candidateUsed, values.candidateReturned);
    if (candidate < baseline) failures.push({
      caseId: values.run.caseId,
      host: values.run.host,
      trial: 0,
      gate: "searchToUse",
      baseline,
      candidate,
    });
  }
}
