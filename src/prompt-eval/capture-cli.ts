import { resolve } from "node:path";
import { runAssertions } from "./assertions";
import { capturePromptEvidence } from "./evidence";
import type { PromptHost } from "./types";

const arg = (name: string): string => {
  const value = process.argv.find((item) => item.startsWith(`--${name}=`))?.slice(name.length + 3);
  if (!value) throw new Error(`missing --${name}=<value>`);
  return value;
};

export function runPromptEvidenceCapture(): void {
  const host = arg("host");
  if (host !== "copilot" && host !== "claude") throw new Error("--host must be copilot or claude");
  const trial = Number(arg("trial"));
  if (!Number.isInteger(trial) || trial < 1) throw new Error("--trial must be an integer >= 1");
  const assertions = runAssertions(resolve(arg("assertions")), resolve(arg("workspace")));
  const evidence = capturePromptEvidence({
    dbPath: resolve(arg("db")),
    host: host as PromptHost,
    sessionId: arg("session"),
    caseId: arg("case"),
    trial,
    taskAssertionSet: assertions.assertionSet,
    taskAssertionsPassed: assertions.passed,
    taskAssertionsTotal: assertions.total,
  });
  console.log(JSON.stringify(evidence, null, 2));
}
