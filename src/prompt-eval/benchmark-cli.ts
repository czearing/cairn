import { resolve } from "node:path";
import { recordPromptEvaluation } from "../core/quality-record";
import { runPromptComparison } from "./benchmark-runner";

const arg = (name: string, required = true): string => {
  const value = process.argv.find((item) => item.startsWith(`--${name}=`))
    ?.slice(name.length + 3);
  if (!value && required) throw new Error(`missing --${name}=<path>`);
  return value || "";
};

export async function runPromptBenchmarkCli(): Promise<number> {
  const result = await runPromptComparison({
    planPath: resolve(arg("plan")),
    baselinePromptPath: resolve(arg("baseline")),
    candidatePromptPath: resolve(arg("candidate")),
    outputDirectory: resolve(arg("output")),
    sourceDatabase: arg("source-db", false) || undefined,
  });
  recordPromptEvaluation(result.evaluation);
  console.log(JSON.stringify(result.evaluation, null, 2));
  return result.evaluation.accepted ? 0 : 1;
}
