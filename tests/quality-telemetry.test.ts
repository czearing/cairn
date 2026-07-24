import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  beginTelemetryRun as beginQualityRun,
  finishTelemetryRun as finishQualityRun,
  jsonChars,
  promptFingerprint,
  recordPromptEvaluation,
  recordTelemetry,
  recordTelemetryState,
  recordTelemetryTool as recordQualityTool,
  telemetryRunId,
  telemetrySummary,
} from "../src/core/telemetry";
import { releaseVersion } from "../src/core/release";
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
    args: { query: marker }, result: [{ id: "node-a", text: marker, score: 0.91 }], success: true,
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
    args: { query: marker },
    result: {
      _meta: {
        cairn: {
          version: "0.1.0+stale",
          releaseFingerprint: "stale-runtime-release",
          pid: 123,
        },
      },
      content: [{
        text: JSON.stringify([
          { id: "node-1", text: marker, score: 0.95 },
          { id: "node-2", text: marker, score: 0.92 },
          { id: "node-3", text: marker, score: 0.89 },
          { id: "node-4", text: marker, score: 0.87 },
          { id: "node-a", text: marker, score: 0.84 },
        ]),
      }],
    },
    success: true,
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
    ...identity("quality-abandoned"), promptHash: promptFingerprint("abandoned"),
    catalogVersion: "catalog-c", injectedChars: 200,
    ts: Date.now() - 2 * 60 * 60 * 1000,
  });
  beginQualityRun({
    ...identity("quality-active"), promptHash: promptFingerprint("active"),
    catalogVersion: "catalog-d", injectedChars: 200,
  });

  const summary = qualitySummary(1);
  expect(summary).toMatchObject({
    runs: 2,
    activeRuns: 1,
    abandonedRuns: 1,
    completedRate: 100,
    workflowRate: 100,
    toolFailures: 1,
    workflowBlocks: 1,
    completionBlocks: 1,
    searchToUseRate: 33.3,
    top3UseRate: 50,
    maxUsedRank: 5,
    minimumUsedScorePercent: 85,
    runtimeObservedCalls: 1,
    runtimeUnknownCalls: 6,
    runtimeMismatchCalls: 1,
    crossSessionReuseRate: 16.7,
    crossSessionNodes: 1,
    observedNodes: 6,
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
  const unknownRuntime = db.query(`SELECT COUNT(*) AS count FROM telemetry_events
    WHERE kind='tool' AND version='unknown'`).get();
  db.close();
  expect(columns.map((column) => column.name)).not.toContain("content");
  expect(serialized).not.toContain(marker);
  expect(serialized).not.toContain("node-a");
  expect(serialized).not.toContain("skill-a");
  expect(unknownRuntime).toEqual({ count: 6 });
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

test("starting a new turn supersedes the prior active run in the same session", () => {
  qualityDatabase()?.run("DELETE FROM telemetry_events");
  qualityDatabase()?.run("DELETE FROM telemetry_runs");
  const first = { host: "copilot" as const, sessionId: "superseded-session", turnSeq: 1 };
  beginQualityRun({
    ...first,
    promptHash: promptFingerprint("first"),
    catalogVersion: "catalog",
    injectedChars: 100,
  });

  beginQualityRun({
    ...first,
    turnSeq: 2,
    promptHash: promptFingerprint("second"),
    catalogVersion: "catalog",
    injectedChars: 100,
  });
  expect(qualityDatabase()?.query(`SELECT turn_seq,status FROM telemetry_runs
    ORDER BY turn_seq`).all()).toEqual([
      { turn_seq: 1, status: "superseded" },
      { turn_seq: 2, status: "active" },
    ]);
});

test("host tool telemetry correlates content-free MCP transport identity", () => {
    qualityDatabase()?.run("DELETE FROM telemetry_events");
    qualityDatabase()?.run("DELETE FROM telemetry_runs");
    const run = identity("transport-correlation");
    const args = { query: "release coherence" };
    const result = [{ id: "node-a", text: "answer", score: 0.9 }];
    beginQualityRun({
      ...run,
      promptHash: promptFingerprint("correlation"),
      catalogVersion: "catalog",
      injectedChars: 100,
    });
    recordTelemetry({
      kind: "tool_transport",
      source: "mcp",
      toolName: "brain_search",
      inputChars: jsonChars(args),
      outputChars: jsonChars(result),
      success: true,
      eventKey: "transport-event",
      releaseFingerprint: "runtime-fingerprint",
      version: "runtime-version",
    });
    recordQualityTool({
      ...run,
      eventKey: "host-event",
      toolName: "brain_search",
      args,
      result,
      success: true,
    });
    const rows = qualityDatabase()?.query(`SELECT kind,run_id,version,runtime_version
      FROM telemetry_events ORDER BY kind`).all();
    expect(rows).toEqual([
      {
        kind: "brain_returned",
        run_id: telemetryRunId(run),
        version: releaseVersion,
        runtime_version: "",
      },
      {
        kind: "tool",
        run_id: telemetryRunId(run),
        version: "runtime-version",
        runtime_version: "runtime-version",
      },
      {
        kind: "tool_transport",
        run_id: telemetryRunId(run),
        version: "runtime-version",
        runtime_version: "",
      },
    ]);
});
