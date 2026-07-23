import { readFileSync } from "node:fs";
import type { PromptBenchmark, PromptRunEvidence } from "./types";

const booleans = [
  "completed", "workflowPassed", "skillSelected", "brainSearched",
  "searchBeforeWrite", "rootCreated", "rootSynthesized", "rootSynthesizedLast",
] as const;
const numbers = [
  "promptTokens", "createdNodes", "answeredNodes", "citedAnswers", "deepestLevel",
  "returnedNodes", "usedReturnedNodes", "trial",
  "taskAssertionsPassed", "taskAssertionsTotal", "toolFailures", "stopNudges",
  "unexpectedEvents",
] as const;

function run(value: unknown, index: number): PromptRunEvidence {
  if (!value || typeof value !== "object") throw new Error(`run ${index} must be an object`);
  const row = value as Record<string, unknown>;
  if (typeof row.caseId !== "string" || !row.caseId) throw new Error(`run ${index} needs caseId`);
  if (row.host !== "copilot" && row.host !== "claude") throw new Error(`run ${index} has invalid host`);
  for (const field of booleans) {
    if (typeof row[field] !== "boolean") throw new Error(`run ${index}.${field} must be boolean`);
  }
  for (const field of numbers) {
    if (!Number.isFinite(row[field]) || Number(row[field]) < 0) {
      throw new Error(`run ${index}.${field} must be a non-negative number`);
    }
    if (!Number.isInteger(row.trial) || Number(row.trial) < 1) {
      throw new Error(`run ${index}.trial must be an integer >= 1`);
    }
    if (!Array.isArray(row.selectedSkillIds)
      || row.selectedSkillIds.some((id) => typeof id !== "string" || !id)) {
      throw new Error(`run ${index}.selectedSkillIds must be a string array`);
    }
    if (typeof row.taskAssertionSet !== "string" || !row.taskAssertionSet) {
      throw new Error(`run ${index}.taskAssertionSet must be a string`);
    }
  }
  return row as unknown as PromptRunEvidence;
}

export function readPromptBenchmark(path: string): PromptBenchmark {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  if (typeof parsed.name !== "string" || !parsed.name) throw new Error("benchmark needs a name");
  if (typeof parsed.promptHash !== "string" || !parsed.promptHash) {
    throw new Error("benchmark needs promptHash");
  }
  if (!Number.isInteger(parsed.minimumTrials) || Number(parsed.minimumTrials) < 1) {
    throw new Error("benchmark needs minimumTrials >= 1");
  }
  if (typeof parsed.requireQualityImprovement !== "boolean") {
    throw new Error("benchmark needs requireQualityImprovement");
  }
  if (!Array.isArray(parsed.runs) || !parsed.runs.length) throw new Error("benchmark needs runs");
  const runs = parsed.runs.map(run);
  const keys = runs.map((item) => `${item.host}\0${item.caseId}\0${item.trial}`);
  if (new Set(keys).size !== keys.length) throw new Error("benchmark host/case/trial keys must be unique");
  return {
    name: parsed.name,
    promptHash: parsed.promptHash,
    minimumTrials: Number(parsed.minimumTrials),
    requireQualityImprovement: parsed.requireQualityImprovement,
    runs,
  };
}
