import { createHash } from "node:crypto";
import type {
  PromptGateFailure,
  PromptRunEvidence,
} from "./types";

export const ratio = (part: number, total: number): number => total ? part / total : 0;

export const definitionHash = (runs: PromptRunEvidence[]): string =>
  createHash("sha256").update(JSON.stringify({
    version: 2,
    assertionSets: [...new Set(runs.map((run) => run.taskAssertionSet))].sort(),
    invariants: [
      "complete", "workflow", "skill", "search-before-write", "root-last",
      "all-answered", "all-cited", "reuse", "failures", "nudges",
    ],
  })).digest("hex").slice(0, 24);

export function qualityGains(
  baseline: PromptRunEvidence,
  candidate: PromptRunEvidence,
): { gains: number; checks: number } {
  const booleans = [
    "completed", "workflowPassed", "skillSelected", "brainSearched",
    "searchBeforeWrite", "rootCreated", "rootSynthesized", "rootSynthesizedLast",
  ] as const;
  let gains = booleans.filter((field) => candidate[field] && !baseline[field]).length;
  gains += Math.max(0, candidate.taskAssertionsPassed - baseline.taskAssertionsPassed);
  gains += Number(
    ratio(candidate.answeredNodes, candidate.createdNodes)
      > ratio(baseline.answeredNodes, baseline.createdNodes)
  );
  gains += Number(
    ratio(candidate.citedAnswers, candidate.answeredNodes)
      > ratio(baseline.citedAnswers, baseline.answeredNodes)
  );
  gains += Number(
    ratio(candidate.usedReturnedNodes, candidate.returnedNodes)
      > ratio(baseline.usedReturnedNodes, baseline.returnedNodes)
  );
  gains += Math.max(0, baseline.toolFailures - candidate.toolFailures);
  gains += Math.max(0, baseline.stopNudges - candidate.stopNudges);
  gains += Math.max(0, baseline.unexpectedEvents - candidate.unexpectedEvents);
  return { gains, checks: booleans.length + baseline.taskAssertionsTotal + 6 };
}

export function compareRun(
  baseline: PromptRunEvidence,
  candidate: PromptRunEvidence,
): PromptGateFailure[] {
  const failures: PromptGateFailure[] = [];
  const gate = (
    name: string,
    expected: number | boolean | string,
    actual: number | boolean | string,
    passed: boolean,
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
  gate("answeredNodes", candidate.createdNodes, candidate.answeredNodes,
    candidate.answeredNodes === candidate.createdNodes);
  gate("citationCoverage", 1, ratio(candidate.citedAnswers, candidate.answeredNodes),
    candidate.answeredNodes > 0 && candidate.citedAnswers === candidate.answeredNodes);
  gate("toolFailures", baseline.toolFailures, candidate.toolFailures,
    candidate.toolFailures <= baseline.toolFailures);
  gate("stopNudges", baseline.stopNudges, candidate.stopNudges,
    candidate.stopNudges <= baseline.stopNudges);
  gate("unexpectedEvents", baseline.unexpectedEvents, candidate.unexpectedEvents,
    candidate.unexpectedEvents <= baseline.unexpectedEvents);
  return failures;
}
