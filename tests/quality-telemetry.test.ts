import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  beginTelemetryRun as beginQualityRun,
  finishTelemetryRun as finishQualityRun,
  promptFingerprint,
  recordPromptEvaluation,
  recordTelemetryState,
  recordTelemetryTool as recordQualityTool,
  telemetrySummary,
} from "../src/core/telemetry";
import { telemetryDatabase as qualityDatabase } from "../src/core/telemetry-schema";
const qualitySummary = (days: number) => telemetrySummary(days).quality;

const identity = (sessionId: string) => ({ host: "copilot" as const, sessionId, turnSeq: 1 });

test("quality telemetry derives reuse and release deltas without storing content", () => {
  qualityDatabase()?.run("DELETE FROM telemetry_events");
  qualityDatabase()?.run("DELETE FROM telemetry_runs");
  const marker = `private-quality-${crypto.randomUUID()}`;
  const baseline = identity("quality-baseline");
  const current = identity("quality-current");
  beginQualityRun({
    ...baseline, promptHash: promptFingerprint("baseline"), catalogVersion: "catalog-a",
    injectedChars: 400, ts: Date.now() - 1000,
  });
  recordQualityTool({
    ...baseline, eventKey: "baseline-search", toolName: "brain_search",
    args: { query: marker }, result: [{ id: "node-a", text: marker }], success: true,
  });
  recordQualityTool({
    ...baseline, eventKey: "baseline-use", toolName: "brain_mutate",
    args: { id: "node-a", answer: marker }, result: { id: "node-a" }, success: true,
  });
  recordQualityTool({
    ...baseline, eventKey: "baseline-skill", toolName: "skill_select",
    args: { ids: ["skill-a"] }, result: { selected: [{ id: "skill-a" }] }, success: true,
  });
  finishQualityRun({
    ...baseline, completed: true, workflowPassed: true, skillUsed: true,
    brainUsed: true, stopNudges: 1,
  });

  beginQualityRun({
    ...current, promptHash: promptFingerprint("current"), catalogVersion: "catalog-b",
    injectedChars: 320,
  });
  recordTelemetryState({
    ...current, eventKey: "current-workflow-block", kind: "stop_blocked",
  });
  recordTelemetryState({
    ...current, eventKey: "current-completion-block", kind: "completion_blocked",
  });
  recordQualityTool({
    ...current, eventKey: "current-search", toolName: "brain_search",
    args: { query: marker }, result: [{ id: "node-a", text: marker }], success: true,
  });
  recordQualityTool({
    ...current, eventKey: "current-create", toolName: "brain_create",
    args: { text: marker, edges: ["node-a"] }, result: { id: "node-b" }, success: true,
  });
  recordQualityTool({
    ...current, eventKey: "current-skill", toolName: "skill_select",
    args: { ids: ["skill-a"] }, result: { selected: [{ id: "skill-a" }] }, success: true,
  });
  recordQualityTool({
    ...current, eventKey: "current-edit", toolName: "skill_edit",
    args: { id: "skill-a", master: marker }, result: { ok: true }, success: true,
  });
  recordQualityTool({
    ...current, eventKey: "current-failure", toolName: "Edit",
    args: {}, result: { success: false }, success: false,
  });
  finishQualityRun({
    ...current, completed: true, workflowPassed: true, skillUsed: true,
    brainUsed: true, stopNudges: 0,
  });
  beginQualityRun({
    ...identity("quality-active"), promptHash: promptFingerprint("active"),
    catalogVersion: "catalog-c", injectedChars: 200,
  });

  const summary = qualitySummary(1);
  expect(summary).toMatchObject({
    runs: 3,
    activeRuns: 1,
    completedRate: 100,
    workflowRate: 100,
    toolFailures: 1,
    workflowBlocks: 1,
    completionBlocks: 1,
    searchToUseRate: 100,
    crossSessionReuseRate: 50,
    crossSessionNodes: 1,
    observedNodes: 2,
    selectedSkills: 1,
    editedSkills: 1,
    skillEditRate: 100,
  });
  expect(summary.current).not.toBeNull();
  expect(summary.baseline).not.toBeNull();
  expect(summary.delta).not.toBeNull();
  expect(summary.comparisons).toHaveLength(1);
  expect(summary.comparisons[0]?.host).toBe("copilot");

  const db = new Database(process.env.CAIRN_DB_PATH!, { readonly: true });
  const columns = db.query("PRAGMA table_info(telemetry_events)").all() as { name: string }[];
  const serialized = JSON.stringify(db.query("SELECT * FROM telemetry_events").all());
  db.close();
  expect(columns.map((column) => column.name)).not.toContain("content");
  expect(serialized).not.toContain(marker);
  expect(serialized).not.toContain("node-a");
  expect(serialized).not.toContain("skill-a");
});

test("quality telemetry records content-free prompt evaluation provenance", () => {
  qualityDatabase()?.run("DELETE FROM telemetry_evaluations");
  recordPromptEvaluation({
    accepted: true,
    baselinePromptHash: "baseline-hash",
    candidatePromptHash: "candidate-hash",
    qualityDefinitionHash: "quality-hash",
    baselineTokens: 1000,
    candidateTokens: 500,
    tokenReduction: 0.5,
    safeTokenReduction: 0.5,
    qualityImprovements: 2,
    qualityChecks: 12,
    comparedRuns: 6,
    failures: [],
  });

  expect(qualitySummary(1)).toMatchObject({
    promptEvaluations: 1,
    acceptedPromptEvaluations: 1,
    latestPromptEvaluation: {
      candidatePromptHash: "candidate-hash",
      accepted: true,
      tokenReduction: 0.5,
      qualityImprovements: 2,
      qualityChecks: 12,
      comparedRuns: 6,
    },
  });
});

test("quality summaries exclude benchmark runs", () => {
  qualityDatabase()?.run("DELETE FROM telemetry_events");
  qualityDatabase()?.run("DELETE FROM telemetry_runs");
  const previous = process.env.CAIRN_PROMPT_BENCHMARK_SESSION;
  process.env.CAIRN_PROMPT_BENCHMARK_SESSION = "benchmark";
  try {
    const run = identity("quality-benchmark");
    beginQualityRun({
      ...run,
      promptHash: promptFingerprint("benchmark"),
      catalogVersion: "catalog",
      injectedChars: 400,
    });
    finishQualityRun({
      ...run,
      completed: true,
      workflowPassed: true,
      skillUsed: true,
      brainUsed: true,
      stopNudges: 0,
    });
  } finally {
    if (previous == null) delete process.env.CAIRN_PROMPT_BENCHMARK_SESSION;
    else process.env.CAIRN_PROMPT_BENCHMARK_SESSION = previous;
  }
  expect(qualitySummary(1).runs).toBe(0);
});
