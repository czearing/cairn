import { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { cairnMcpConfigPath } from "../skill/cairn-mcp";
import { runClaude } from "../skill/claude";
import { runCopilot } from "../skill/copilot";
import type { Assertion } from "./assertions";
import type { PromptHost } from "./types";

export interface BenchmarkCase {
  id: string;
  task: string;
  assertions: Assertion[];
}

export interface BenchmarkPlan {
  name: string;
  hosts: PromptHost[];
  minimumTrials: number;
  requireQualityImprovement: boolean;
  models?: Partial<Record<PromptHost, string>>;
  candidateCatalogMode?: "full" | "titles";
  cases: BenchmarkCase[];
}

const tools = [
  "mcp__cairn__skill_select",
  "mcp__cairn__brain_search",
  "mcp__cairn__brain_create",
  "mcp__cairn__brain_mutate",
  "mcp__cairn__benchmark_submit",
];

export function readBenchmarkPlan(path: string): BenchmarkPlan {
  const plan = JSON.parse(readFileSync(path, "utf8")) as BenchmarkPlan;
  if (!plan.name || !Array.isArray(plan.hosts) || !plan.hosts.length) {
    throw new Error("benchmark plan needs name and hosts");
  }
  if (!Number.isInteger(plan.minimumTrials) || plan.minimumTrials < 1) {
    throw new Error("benchmark plan needs minimumTrials >= 1");
  }
  if (typeof plan.requireQualityImprovement !== "boolean") {
    throw new Error("benchmark plan needs requireQualityImprovement");
  }
  if (!Array.isArray(plan.cases) || !plan.cases.length) {
    throw new Error("benchmark plan needs cases");
  }
  return plan;
}

export function databaseSnapshot(path: string): Uint8Array {
  if (!existsSync(path)) throw new Error(`source database not found: ${path}`);
  const db = new Database(path, { readonly: true });
  try {
    return db.serialize();
  } finally {
    db.close();
  }
}

export async function stopBenchmarkProcess(path: string): Promise<void> {
  if (!existsSync(path)) return;
  const pid = Number(readFileSync(path, "utf8"));
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return;
  try { process.kill(pid); } catch { return; }
  while (true) {
    await Bun.sleep(50);
    try { process.kill(pid, 0); } catch { return; }
  }
}

export async function runBenchmarkHost(
  host: PromptHost,
  task: string,
  prompt: string,
  env: Record<string, string>,
  plan: BenchmarkPlan,
) {
  const opts = {
    system: prompt,
    allowedTools: tools,
    mcpConfigPath: cairnMcpConfigPath(),
    env,
    model: plan.models?.[host],
  };
  if (host === "claude") return runClaude(task, opts);
  const previous = process.env.CAIRN_SKILL_WORKER;
  process.env.CAIRN_SKILL_WORKER = "1";
  try {
    return await runCopilot(task, opts);
  } finally {
    if (previous == null) delete process.env.CAIRN_SKILL_WORKER;
    else process.env.CAIRN_SKILL_WORKER = previous;
  }
}
