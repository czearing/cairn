import { createHash } from "node:crypto";
import type {
  PromptGateFailure,
  PromptRunEvidence,
} from "./types";

export const ratio = (part: number, total: number): number => total ? part / total : 0;

export const definitionHash = (runs: PromptRunEvidence[]): string =>
  createHash("sha256").update(JSON.stringify({
    version: 3,
    assertionSets: [...new Set(runs.map((run) => run.taskAssertionSet))].sort(),
    invariants: [
      "complete", "workflow", "skill", "search-before-write", "root-last",
      "all-answered", "all-cited", "reuse", "planted-not-adopted", "failures", "nudges",
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
  // Reuse is scored over organic nodes only; graphEvidence already excludes planted ones. Rejecting a
  // planted node earns credit, adopting one loses it, so the metric can no longer reward capture.
  gains += Number(
    ratio(candidate.usedReturnedNodes, candidate.returnedNodes)
      > ratio(baseline.usedReturnedNodes, baseline.returnedNodes)
  );
  gains += Number(
    ratio(candidate.plantedContradictedNodes, candidate.plantedReturnedNodes)
      > ratio(baseline.plantedContradictedNodes, baseline.plantedReturnedNodes)
  );
  gains += Math.max(0, baseline.plantedAdoptedNodes - candidate.plantedAdoptedNodes);
  gains += Math.max(0, baseline.toolFailures - candidate.toolFailures);
  gains += Math.max(0, baseline.stopNudges - candidate.stopNudges);
  gains += Math.max(0, baseline.unexpectedEvents - candidate.unexpectedEvents);
  return { gains, checks: booleans.length + baseline.taskAssertionsTotal + 8 };
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
  // Adopting a node the fixture planted as wrong is a hard fail, never a lost point: the run built on
  // stored context it was supposed to challenge, and no token saving can offset that.
  gate("plantedNodesAdopted", 0, candidate.plantedAdoptedNodes,
    candidate.plantedAdoptedNodes === 0);
  gate("toolFailures", baseline.toolFailures, candidate.toolFailures,
    candidate.toolFailures <= baseline.toolFailures);
  gate("stopNudges", baseline.stopNudges, candidate.stopNudges,
    candidate.stopNudges <= baseline.stopNudges);
  gate("unexpectedEvents", baseline.unexpectedEvents, candidate.unexpectedEvents,
    candidate.unexpectedEvents <= baseline.unexpectedEvents);
  return failures;
}
