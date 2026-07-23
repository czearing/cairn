import { createHash, randomUUID } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { config } from "../core/config";
import { estimatedTokens } from "../core/telemetry";
import { formatSkillCatalog } from "../skill/catalog";
import { runAssertions } from "./assertions";
import {
  databaseSnapshot,
  readBenchmarkPlan,
  runBenchmarkHost,
  stopBenchmarkProcess,
  type BenchmarkPlan,
} from "./benchmark-host";
import {
  beginBenchmarkRun,
  finishBenchmarkRun,
  initializeBenchmarkDatabase,
} from "./benchmark-record";
import { capturePromptEvidence } from "./evidence";
import { evaluatePrompt } from "./score";
import type { PromptBenchmark } from "./types";

const hash = (value: string): string =>
  createHash("sha256").update(value).digest("hex").slice(0, 24);

export function prepareBenchmarkRunDatabase(
  path: string,
  snapshot: Uint8Array,
  name: string,
  promptHash: string,
): void {
  writeFileSync(path, snapshot);
  initializeBenchmarkDatabase(path, name, promptHash);
}

function promptProfile(dir?: string): string {
  if (!dir) return "";
  return readdirSync(dir).sort().map((name) => {
    const path = join(dir, name);
    return statSync(path).isFile() ? `${name}\n${readFileSync(path, "utf8")}` : "";
  }).join("\n");
}

async function runPrompt(
  plan: BenchmarkPlan,
  label: string,
  promptPath: string,
  snapshot: Uint8Array,
  root: string,
  catalogMode: "full" | "titles",
  hookPromptDir?: string,
): Promise<PromptBenchmark> {
  const base = readFileSync(promptPath, "utf8").trim();
  const fullPrompt = `${base}\n\n${formatSkillCatalog(catalogMode)}`;
  const promptHash = hash(`${fullPrompt}\n${promptProfile(hookPromptDir)}`);
  const runs: PromptBenchmark["runs"] = [];
  for (const host of plan.hosts) {
    for (const item of plan.cases) {
      for (let trial = 1; trial <= plan.minimumTrials; trial++) {
        const sessionId = `${label}-${host}-${item.id}-${trial}-${randomUUID()}`;
        const runRoot = join(root, sessionId);
        mkdirSync(runRoot);
        const dbPath = join(runRoot, "benchmark.db");
        const resultPath = join(runRoot, "result.json");
        const pidPath = join(runRoot, "mcp.pid");
        const assertionPath = join(runRoot, "assertions.json");
        prepareBenchmarkRunDatabase(dbPath, snapshot, `${plan.name}-${label}`, promptHash);
        writeFileSync(assertionPath, JSON.stringify({ assertions: item.assertions }));
        beginBenchmarkRun(dbPath, {
          sessionId,
          host,
          caseId: item.id,
          trial,
          promptTokens: estimatedTokens(fullPrompt.length),
        });
        const task = `${item.task}\n\nCall benchmark_submit exactly once with the required final result.`;
        const result = await runBenchmarkHost(host, task, fullPrompt, {
          CAIRN_DB_PATH: dbPath,
          CAIRN_USAGE: "0",
          CAIRN_SKILLS: "1",
          CAIRN_EMBED_NO_SERVER: "1",
          CAIRN_PROMPT_BENCHMARK_SESSION: sessionId,
          CAIRN_PROMPT_BENCHMARK_RESULT: resultPath,
          CAIRN_PROMPT_BENCHMARK_PID_PATH: pidPath,
          ...(hookPromptDir ? { CAIRN_PROMPT_BENCHMARK_DIR: hookPromptDir } : {}),
        }, plan);
        await stopBenchmarkProcess(pidPath);
        if (!result.ok) {
          console.error(`${label}/${host}/${item.id}#${trial}: ${result.error || "run failed"}`);
        }
        const assertions = runAssertions(assertionPath, runRoot);
        finishBenchmarkRun(dbPath, {
          sessionId,
          completed: result.ok,
          workflowPassed: result.ok && assertions.passed === assertions.total,
          assertionSet: assertions.assertionSet,
          assertionsPassed: assertions.passed,
          assertionsTotal: assertions.total,
        });
        runs.push(capturePromptEvidence({
          dbPath,
          host,
          sessionId,
          caseId: item.id,
          trial,
          taskAssertionSet: assertions.assertionSet,
          taskAssertionsPassed: assertions.passed,
          taskAssertionsTotal: assertions.total,
        }));
      }
    }
  }
  return {
    name: `${plan.name}-${label}`,
    promptHash,
    minimumTrials: plan.minimumTrials,
    requireQualityImprovement: plan.requireQualityImprovement,
    runs,
  };
}

export async function runPromptComparison(input: {
  planPath: string;
  baselinePromptPath: string;
  candidatePromptPath: string;
  outputDirectory: string;
  sourceDatabase?: string;
}) {
  const plan = readBenchmarkPlan(resolve(input.planPath));
  const output = resolve(input.outputDirectory);
  mkdirSync(output, { recursive: true });
  const root = join(tmpdir(), `cairn-prompt-benchmark-${randomUUID()}`);
  mkdirSync(root);
  try {
    const snapshot = databaseSnapshot(resolve(input.sourceDatabase || config.dbPath));
    const baseline = await runPrompt(
      plan, "baseline", resolve(input.baselinePromptPath), snapshot, root,
      plan.baselineCatalogMode || "full",
      plan.baselineHookPromptDir ? resolve(plan.baselineHookPromptDir) : undefined);
    const candidate = await runPrompt(
      plan, "candidate", resolve(input.candidatePromptPath), snapshot, root,
      plan.candidateCatalogMode || "full",
      plan.candidateHookPromptDir ? resolve(plan.candidateHookPromptDir) : undefined);
    writeFileSync(join(output, "baseline.json"), JSON.stringify(baseline, null, 2));
    writeFileSync(join(output, "candidate.json"), JSON.stringify(candidate, null, 2));
    return { baseline, candidate, evaluation: evaluatePrompt(baseline, candidate) };
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
}
