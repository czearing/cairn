import { resolve } from "node:path";
import { readPromptBenchmark } from "./files";
import { evaluatePrompt } from "./score";

const arg = (name: string): string => {
  const value = process.argv.find((item) => item.startsWith(`--${name}=`))?.slice(name.length + 3);
  if (!value) throw new Error(`missing --${name}=<json>`);
  return resolve(value);
};

export function runPromptEvaluation(json = process.argv.includes("--json")): number {
  const baseline = readPromptBenchmark(arg("baseline"));
  const candidate = readPromptBenchmark(arg("candidate"));
  const result = evaluatePrompt(baseline, candidate);
  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else if (result.accepted) {
    console.log(`PASS  safe token reduction ${(result.safeTokenReduction! * 100).toFixed(1)}%`);
    console.log(`${result.baselineTokens} -> ${result.candidateTokens} tokens across ${result.comparedRuns} runs`);
  } else {
    console.log(`REJECTED  ${result.failures.length} quality gate failure(s)`);
    for (const failure of result.failures) {
      console.log(`${failure.host}/${failure.caseId}#${failure.trial} ${failure.gate}: `
        + `${failure.candidate} (baseline ${failure.baseline})`);
    }
  }
  return result.accepted ? 0 : 1;
}
