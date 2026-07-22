import type {
  PromptBenchmark,
  PromptEvaluation,
  PromptGateFailure,
  PromptRunEvidence,
} from "./types";

const key = (run: PromptRunEvidence): string => `${run.host}\0${run.caseId}\0${run.trial}`;
const ratio = (part: number, total: number): number => total ? part / total : 0;
const rounded = (value: number): number => Math.round(value * 1000) / 1000;

function compareRun(
  baseline: PromptRunEvidence,
  candidate: PromptRunEvidence
): PromptGateFailure[] {
  const failures: PromptGateFailure[] = [];
  const gate = (
    name: string,
    expected: number | boolean | string,
    actual: number | boolean | string,
    passed: boolean
  ) => {
    if (!passed) failures.push({
      caseId: candidate.caseId,
      host: candidate.host,
      trial: candidate.trial,
      gate: name,
      baseline: expected,
      candidate: actual,
    });
  };
  for (const field of [
    "completed", "workflowPassed", "skillSelected", "brainSearched",
    "searchBeforeWrite", "rootCreated", "rootSynthesized", "rootSynthesizedLast",
  ] as const) {
    gate(field, true, candidate[field], candidate[field]);
  }
  const baselineSkills = [...baseline.selectedSkillIds].sort().join(",");
  const candidateSkills = [...candidate.selectedSkillIds].sort().join(",");
  gate("selectedSkillIds", baselineSkills, candidateSkills,
    candidateSkills === baselineSkills);
  gate("taskAssertionSet", baseline.taskAssertionSet, candidate.taskAssertionSet,
    candidate.taskAssertionSet === baseline.taskAssertionSet);
  gate("taskAssertions", baseline.taskAssertionsTotal, candidate.taskAssertionsPassed,
    baseline.taskAssertionsTotal > 0
      && candidate.taskAssertionsTotal === baseline.taskAssertionsTotal
      && candidate.taskAssertionsPassed === candidate.taskAssertionsTotal);
  gate("createdNodes", baseline.createdNodes, candidate.createdNodes,
    candidate.createdNodes >= baseline.createdNodes);
  gate("maxDepth", baseline.maxDepth, candidate.maxDepth,
    candidate.maxDepth >= baseline.maxDepth);
  gate("answeredNodes", baseline.answeredNodes, candidate.answeredNodes,
    candidate.answeredNodes === candidate.createdNodes
      && candidate.answeredNodes >= baseline.answeredNodes);
  gate("citationCoverage", 1, ratio(candidate.citedAnswers, candidate.answeredNodes),
    candidate.answeredNodes > 0
      && candidate.citedAnswers === candidate.answeredNodes);
  gate("usedReturnedNodes", baseline.usedReturnedNodes, candidate.usedReturnedNodes,
    candidate.usedReturnedNodes >= baseline.usedReturnedNodes);
  gate("searchToUse", ratio(baseline.usedReturnedNodes, baseline.returnedNodes),
    ratio(candidate.usedReturnedNodes, candidate.returnedNodes),
    ratio(candidate.usedReturnedNodes, candidate.returnedNodes)
      >= ratio(baseline.usedReturnedNodes, baseline.returnedNodes));
  gate("toolFailures", baseline.toolFailures, candidate.toolFailures,
    candidate.toolFailures <= baseline.toolFailures);
  gate("stopNudges", baseline.stopNudges, candidate.stopNudges,
    candidate.stopNudges <= baseline.stopNudges);
  gate("unexpectedEvents", baseline.unexpectedEvents, candidate.unexpectedEvents,
    candidate.unexpectedEvents <= baseline.unexpectedEvents);
  return failures;
}

export function evaluatePrompt(
  baseline: PromptBenchmark,
  candidate: PromptBenchmark
): PromptEvaluation {
  const candidates = new Map(candidate.runs.map((run) => [key(run), run]));
  const failures: PromptGateFailure[] = [];
  const trialCounts = new Map<string, number>();
  for (const run of baseline.runs) {
    const group = `${run.host}\0${run.caseId}`;
    trialCounts.set(group, (trialCounts.get(group) || 0) + 1);
  }
  for (const [group, count] of trialCounts) {
    if (count >= baseline.minimumTrials) continue;
    const [host, caseId] = group.split("\0") as [PromptRunEvidence["host"], string];
    failures.push({
      caseId,
      host,
      trial: 0,
      gate: "minimumTrials",
      baseline: baseline.minimumTrials,
      candidate: count,
    });
  }
  if (candidate.minimumTrials !== baseline.minimumTrials) {
    for (const run of baseline.runs.slice(0, 1)) failures.push({
      caseId: run.caseId,
      host: run.host,
      trial: run.trial,
      gate: "minimumTrialsConfig",
      baseline: baseline.minimumTrials,
      candidate: candidate.minimumTrials,
    });
  }
  for (const run of baseline.runs) {
    const found = candidates.get(key(run));
    if (!found) {
      failures.push({
        caseId: run.caseId,
        host: run.host,
        trial: run.trial,
        gate: "runPresent",
        baseline: true,
        candidate: false,
      });
      continue;
    }
    failures.push(...compareRun(run, found));
    candidates.delete(key(run));
  }
  for (const extra of candidates.values()) {
    failures.push({
      caseId: extra.caseId,
      host: extra.host,
      trial: extra.trial,
      gate: "unexpectedRun",
      baseline: false,
      candidate: true,
    });
  }
  const baselineTokens = baseline.runs.reduce((sum, run) => sum + run.promptTokens, 0);
  const candidateTokens = candidate.runs.reduce((sum, run) => sum + run.promptTokens, 0);
  const tokenReduction = baselineTokens
    ? rounded(1 - candidateTokens / baselineTokens)
    : 0;
  return {
    accepted: failures.length === 0,
    baselineTokens,
    candidateTokens,
    tokenReduction,
    safeTokenReduction: failures.length ? null : tokenReduction,
    comparedRuns: baseline.runs.length,
    failures,
  };
}
