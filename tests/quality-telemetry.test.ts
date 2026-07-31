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
import { telemetryQualityVerdict } from "../src/core/telemetry-quality-verdict";
const qualitySummary = (days: number) => telemetrySummary(days).quality;

const identity = (sessionId: string) => ({ host: "copilot" as const, sessionId, turnSeq: 1 });

test("quality telemetry derives reuse and excludes mixed-runtime release comparisons", () => {
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
  recordTelemetryState({
    ...baseline, eventKey: "baseline-receipt", kind: "skill_receipt_checked",
    success: true, itemCount: 2, value: 2,
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
  recordTelemetryState({
    ...current, eventKey: "current-skill-correction-required", kind: "skill_correction_required",
  });
  recordTelemetryState({
    ...current, eventKey: "current-skill-correction-blocked", kind: "skill_correction_blocked",
  });
  recordTelemetryState({
    ...current, eventKey: "current-skill-correction-resolved", kind: "skill_correction_resolved",
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
  recordTelemetryState({
    ...current, eventKey: "current-receipt", kind: "skill_receipt_checked",
    success: true, itemCount: 3, value: 3,
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
    progressingActiveRuns: 1,
    stalledActiveRuns: 0,
    abandonedRuns: 1,
    completedRate: 100,
    workflowRate: 100,
    toolFailures: 1,
    workflowBlocks: 1,
    completionBlocks: 1,
    searchToUseRate: 33.3,
    rankedUsedReturnedNodes: 2,
    top3UseRate: 50,
    maxUsedRank: 5,
    minimumUsedScorePercent: 85,
    runtimeObservedCalls: 1,
    runtimeUnknownCalls: 6,
    runtimeMismatchCalls: 1,
    coherentRuns: 0,
    mixedRuntimeRuns: 1,
    unattributedRuntimeRuns: 1,
    crossSessionReuseRate: 100,
    crossSessionNodes: 1,
    observedNodes: 1,
    selectedSkills: 1,
    editedSkills: 1,
    skillEditRate: 100,
    skillCorrectionsRequired: 1,
    skillCorrectionsResolved: 1,
    skillCorrectionBlocks: 1,
    skillCorrectionResolutionRate: 100,
    skillReceiptChecks: 2,
    completeSkillReceipts: 2,
    skillReceiptComplianceRate: 100,
    duplicateSkillReceipts: 0,
    expectedSkillReceiptSteps: 5,
    reportedSkillReceiptSteps: 5,
  });
  expect(summary.current).toBeNull();
  expect(summary.baseline).toBeNull();
  expect(summary.delta).toBeNull();
  expect(summary.comparisons).toEqual([]);
  const verdict = telemetryQualityVerdict({
    ...summary,
    latestVersion: "behavior-release",
    runs: 38,
    workflowRate: 0,
    visibilityFailures: 38,
  }, {
    releaseFingerprint: "engine-release",
    version: "engine-release",
    toolSchemas: { tools: 0, chars: 0, estimatedTokens: 0, version: "", definitions: [] },
    searchStages: [],
    engineTransports: [{
      source: "daemon",
      operation: "search",
      calls: 10,
      averageDurationMs: 55,
      maximumDurationMs: 90,
      failures: 0,
    }],
    parity: { checks: 10, mismatches: 0 },
  });

  expect(verdict).toMatchObject({
    status: "outage",
    releaseCoherent: false,
    behavior: { visibilityFailureRate: 100, workflowRate: 0 },
    infrastructure: { transportCalls: 10, transportFailures: 0 },
  });

  expect(verdict.issues).toContain(
    "Behavior (behavior-release) and infrastructure (engine-release) are from different releases."
  );

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

test("cross-session reuse includes prior releases and active stalls use event inactivity", () => {
  const db = qualityDatabase()!;
  db.run("DELETE FROM telemetry_events");
  db.run("DELETE FROM telemetry_runs");
  const old = identity(`quality-prior-${crypto.randomUUID()}`);
  const current = identity(`quality-reuse-${crypto.randomUUID()}`);
  beginQualityRun({
    ...old, promptHash: promptFingerprint("prior"), catalogVersion: "old", injectedChars: 1,
    ts: Date.now() - 60_000,
  });
  recordQualityTool({
    ...old, eventKey: "old-create", toolName: "brain_create",
    args: { text: "prior" }, result: { id: "shared-node" }, success: true,
  });
  recordQualityTool({
    ...old, eventKey: "old-create-preused", toolName: "brain_create",
    args: { text: "prior preused" }, result: { id: "preused-node" }, success: true,
  });
  finishQualityRun({
    ...old, completed: true, workflowPassed: true, skillUsed: true,
    brainUsed: true, stopNudges: 0,
  });
  db.query("UPDATE telemetry_runs SET version='0.1.0+prior',release_fingerprint='prior' WHERE run_id=?")
    .run(telemetryRunId(old));

  beginQualityRun({
    ...current, promptHash: promptFingerprint("current"), catalogVersion: "current", injectedChars: 1,
  });
  recordQualityTool({
    ...current, eventKey: "current-preuse-shared", toolName: "brain_mutate",
    args: { id: "shared-node", answer: "used before and after recall" },
    result: { id: "shared-node" }, success: true,
  });
  recordQualityTool({
    ...current, eventKey: "current-preuse", toolName: "brain_mutate",
    args: { id: "preused-node", answer: "used too early" },
    result: { id: "preused-node" }, success: true,
  });
  recordQualityTool({
    ...current, eventKey: "current-search", toolName: "brain_search",
    args: { query: "shared" }, result: [
      { id: "shared-node", score: 0.9 },
      { id: "preused-node", score: 0.8 },
    ], success: true,
  });
  recordQualityTool({
    ...current, eventKey: "current-mutate", toolName: "brain_mutate",
    args: { id: "shared-node", answer: "used" }, result: { id: "shared-node" }, success: true,
  });
  recordTelemetryState({
    ...current, eventKey: "current-receipt", kind: "skill_receipt_checked",
    success: true, itemCount: 1, value: 1,
  });
  finishQualityRun({
    ...current, completed: true, workflowPassed: true, skillUsed: true,
    brainUsed: true, stopNudges: 0,
  });

  const stalled = identity(`quality-stalled-${crypto.randomUUID()}`);
  beginQualityRun({
    ...stalled, promptHash: promptFingerprint("stalled"), catalogVersion: "current",
    injectedChars: 1, ts: Date.now() - 15 * 60_000,
  });
  const summary = qualitySummary(1);
  expect(summary).toMatchObject({
    runs: 1,
    activeRuns: 1,
    progressingActiveRuns: 0,
    stalledActiveRuns: 1,
    crossSessionEligibleNodes: 2,
    crossSessionReusedNodes: 1,
    crossSessionReuseRate: 50,
  });
  expect(summary.oldestActiveActivityMinutes).toBeGreaterThanOrEqual(14);
  expect(summary.verdict.issues).toContain("1/1 active human runs are stalled.");
});

test("quality verdict scopes outages to the latest runtime release", () => {
  const db = qualityDatabase()!;
  db.run("DELETE FROM telemetry_events");
  db.run("DELETE FROM telemetry_runs");
  const old = identity("quality-old-outage");
  beginQualityRun({
    ...old,
    promptHash: promptFingerprint("old outage"),
    catalogVersion: "catalog-old",
    injectedChars: 0,
  });
  recordTelemetryState({
    ...old,
    eventKey: "old-visibility-failure",
    kind: "visibility_failure",
  });
  finishQualityRun({
    ...old,
    completed: true,
    workflowPassed: false,
    skillUsed: false,
    brainUsed: false,
    stopNudges: 0,
  });
  db.run("UPDATE telemetry_runs SET version='0.1.0+old',release_fingerprint='old-release'");

  const healthy = identity("quality-current-healthy");
  beginQualityRun({
    ...healthy,
    promptHash: promptFingerprint("current healthy"),
    catalogVersion: "catalog-current",
    injectedChars: 0,
  });
  finishQualityRun({
    ...healthy,
    completed: true,
    workflowPassed: true,
    skillUsed: true,
    brainUsed: true,
    stopNudges: 0,
  });

  expect(qualitySummary(1)).toMatchObject({
    latestVersion: releaseVersion,
    runs: 1,
    workflowRate: 100,
    visibilityFailures: 0,
  });

  const currentFailure = identity("quality-current-outage");
  beginQualityRun({
    ...currentFailure,
    promptHash: promptFingerprint("current outage"),
    catalogVersion: "catalog-current",
    injectedChars: 0,
  });
  recordTelemetryState({
    ...currentFailure,
    eventKey: "current-visibility-failure",
    kind: "visibility_failure",
  });
  finishQualityRun({
    ...currentFailure,
    completed: true,
    workflowPassed: false,
    skillUsed: false,
    brainUsed: false,
    stopNudges: 0,
  });

  const current = qualitySummary(1);
  expect(current).toMatchObject({
    runs: 2,
    workflowRate: 50,
    visibilityFailures: 1,
    verdict: {
      status: "outage",
      behavior: { visibilityFailureRate: 50 },
    },
  });
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

test("release comparisons do not mix workload sizes", () => {
  qualityDatabase()?.run("DELETE FROM telemetry_events");
  qualityDatabase()?.run("DELETE FROM telemetry_runs");
  const small = identity("workload-small");
  const large = identity("workload-large");
  beginQualityRun({
    ...small,
    promptHash: promptFingerprint("small"),
    catalogVersion: "catalog",
    injectedChars: 100,
  });
  finishQualityRun({
    ...small,
    completed: true,
    workflowPassed: true,
    skillUsed: true,
    brainUsed: true,
    stopNudges: 0,
  });
  beginQualityRun({
    ...large,
    promptHash: promptFingerprint("large"),
    catalogVersion: "catalog",
    injectedChars: 100,
  });
  qualityDatabase()?.query("UPDATE telemetry_runs SET tool_calls=51 WHERE run_id=?")
    .run(telemetryRunId(large));
  finishQualityRun({
    ...large,
    completed: true,
    workflowPassed: true,
    skillUsed: true,
    brainUsed: true,
    stopNudges: 0,
  });
  const comparisons = qualitySummary(1).comparisons;
  expect(comparisons.map((item) => item.workload).sort()).toEqual(["large", "small"]);
  expect(comparisons.every((item) => item.baseline === null && item.delta === null)).toBe(true);
});

test("behavior rates fall back to the newest release that has a completed sample", () => {
  qualityDatabase()?.run("DELETE FROM telemetry_events");
  qualityDatabase()?.run("DELETE FROM telemetry_runs");
  const sampled = identity("quality-sampled-release");
  beginQualityRun({
    ...sampled, promptHash: promptFingerprint("sampled"), catalogVersion: "catalog-a",
    injectedChars: 300,
  });
  finishQualityRun({
    ...sampled, completed: true, workflowPassed: true, skillUsed: true, brainUsed: true, stopNudges: 0,
  });
  // A rebuild lands and only has an in-flight run: the previous release must still supply the rates.
  qualityDatabase()?.run(
    `INSERT INTO telemetry_runs (run_id,host,session_hash,turn_seq,release_fingerprint,version,
      run_class,started_ts,status) VALUES (?,?,?,?,?,?,?,?,?)`,
    ["run-newer", "copilot", "hash-newer", 1, "fingerprint-newer", "9.9.9+newer", "human", Date.now() + 60_000, "active"]
  );

  const quality = qualitySummary(7);
  expect(quality.latestVersion).toBe("9.9.9+newer");
  expect(quality.sampleVersion).toBe(releaseVersion);
  expect(quality.runs).toBe(1);
  expect(quality.completedRate).toBe(100);
  expect(quality.activeRuns).toBe(1);
  expect(quality.verdict.issues.some((issue) => issue.includes("9.9.9+newer"))).toBe(true);
  expect(quality.verdict.issues).not.toContain("No completed human behavior samples.");
});

test("mixed-runtime runs are disclosed instead of silently dropped from release comparisons", () => {
  qualityDatabase()?.run("DELETE FROM telemetry_events");
  qualityDatabase()?.run("DELETE FROM telemetry_runs");
  const coherent = identity("coherence-disclosed-ok");
  const mixed = identity("coherence-disclosed-mixed");
  const toolArgs = { query: "coherence" };
  const toolResult = [{ id: "node-a", text: "answer", score: 0.9 }];
  const transport = (eventKey: string, version: string) => recordTelemetry({
    kind: "tool_transport", source: "mcp", toolName: "brain_search",
    inputChars: jsonChars(toolArgs), outputChars: jsonChars(toolResult), success: true,
    eventKey, releaseFingerprint: "fingerprint", version,
  });

  beginQualityRun({
    ...coherent, promptHash: promptFingerprint("shared"), catalogVersion: "catalog", injectedChars: 100,
  });
  transport("disclosed-ok-transport", releaseVersion);
  recordQualityTool({
    ...coherent, eventKey: "disclosed-ok-tool", toolName: "brain_search",
    args: toolArgs, result: toolResult, success: true,
  });
  finishQualityRun({
    ...coherent, completed: true, workflowPassed: true, skillUsed: true, brainUsed: true, stopNudges: 0,
  });

  // The hook adopted a new release mid-session while the long-lived runtime kept the old build.
  beginQualityRun({
    ...mixed, promptHash: promptFingerprint("shared"), catalogVersion: "catalog", injectedChars: 100,
  });
  transport("disclosed-mixed-transport", "0.0.0+stale");
  recordQualityTool({
    ...mixed, eventKey: "disclosed-mixed-tool", toolName: "brain_search",
    args: toolArgs, result: toolResult, success: true,
  });
  finishQualityRun({
    ...mixed, completed: true, workflowPassed: true, skillUsed: true, brainUsed: true, stopNudges: 0,
  });

  const quality = qualitySummary(7);
  expect(quality.coherentRuns).toBe(1);
  expect(quality.mixedRuntimeRuns).toBe(1);
  const comparison = quality.comparisons.at(0);
  expect(comparison?.current.runs).toBe(1);
  expect(comparison?.current.excludedRuns).toBe(1);
  expect(quality.verdict.issues.some((issue) => issue.includes("excluded from release"))).toBe(true);
});

test("one unattributed call does not discard a run whose other calls confirm the release", () => {
  qualityDatabase()?.run("DELETE FROM telemetry_events");
  qualityDatabase()?.run("DELETE FROM telemetry_runs");
  const run = identity("coherence-partial-attribution");
  const toolArgs = { query: "coherence" };
  const toolResult = [{ id: "node-a", text: "answer", score: 0.9 }];

  beginQualityRun({
    ...run, promptHash: promptFingerprint("shared"), catalogVersion: "catalog", injectedChars: 100,
  });
  recordTelemetry({
    kind: "tool_transport", source: "mcp", toolName: "brain_search",
    inputChars: jsonChars(toolArgs), outputChars: jsonChars(toolResult), success: true,
    eventKey: "partial-attributed-transport", releaseFingerprint: "fingerprint",
    version: releaseVersion,
  });
  recordQualityTool({
    ...run, eventKey: "partial-attributed-tool", toolName: "brain_search",
    args: toolArgs, result: toolResult, success: true,
  });
  // A second call carries no runtime identity at all, which is missing attribution rather than
  // evidence that the runtime was a different release.
  recordQualityTool({
    ...run, eventKey: "partial-unattributed-tool", toolName: "brain_mutate",
    args: { id: "node-a" }, result: { id: "node-a" }, success: true,
  });
  finishQualityRun({
    ...run, completed: true, workflowPassed: true, skillUsed: true, brainUsed: true, stopNudges: 0,
  });

  const quality = qualitySummary(7);
  expect(quality.coherentRuns).toBe(1);
  expect(quality.mixedRuntimeRuns).toBe(0);
  expect(quality.unattributedRuntimeRuns).toBe(0);
  expect(quality.comparisons.at(0)?.current.runs).toBe(1);
});

test("a run with no attributed Cairn call is reported as unattributed, not as a release mismatch", () => {
  qualityDatabase()?.run("DELETE FROM telemetry_events");
  qualityDatabase()?.run("DELETE FROM telemetry_runs");
  const run = identity("coherence-unattributed");

  beginQualityRun({
    ...run, promptHash: promptFingerprint("shared"), catalogVersion: "catalog", injectedChars: 100,
  });
  recordQualityTool({
    ...run, eventKey: "unattributed-tool", toolName: "brain_search",
    args: { query: "coherence" }, result: [{ id: "node-a", text: "answer", score: 0.9 }],
    success: true,
  });
  finishQualityRun({
    ...run, completed: true, workflowPassed: true, skillUsed: true, brainUsed: true, stopNudges: 0,
  });

  const quality = qualitySummary(7);
  expect(quality.mixedRuntimeRuns).toBe(0);
  expect(quality.unattributedRuntimeRuns).toBe(1);
  expect(quality.coherentRuns).toBe(0);
  expect(quality.verdict.issues.some((issue) => issue.includes("no runtime"))).toBe(true);
});

test("behavior rates prefer the newest release that has a comparable sample", () => {
  qualityDatabase()?.run("DELETE FROM telemetry_events");
  qualityDatabase()?.run("DELETE FROM telemetry_runs");
  const older = identity("sample-comparable-older");
  const toolArgs = { query: "sample" };
  const toolResult = [{ id: "node-a", text: "answer", score: 0.9 }];

  beginQualityRun({
    ...older, promptHash: promptFingerprint("older"), catalogVersion: "catalog", injectedChars: 100,
    ts: Date.now() - 60_000,
  });
  recordTelemetry({
    kind: "tool_transport", source: "mcp", toolName: "brain_search",
    inputChars: jsonChars(toolArgs), outputChars: jsonChars(toolResult), success: true,
    eventKey: "sample-older-transport", releaseFingerprint: "fingerprint", version: releaseVersion,
  });
  recordQualityTool({
    ...older, eventKey: "sample-older-tool", toolName: "brain_search",
    args: toolArgs, result: toolResult, success: true,
  });
  finishQualityRun({
    ...older, completed: true, workflowPassed: true, skillUsed: true, brainUsed: true, stopNudges: 0,
  });

  // A freshly published release whose only run was served by the previous long-lived runtime.
  qualityDatabase()?.run(
    `INSERT INTO telemetry_runs (run_id,host,session_hash,turn_seq,release_fingerprint,version,
      run_class,started_ts,status,completed,workflow_passed,tool_calls)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    ["run-mismatched-newer", "copilot", "hash-newer", 1, "fingerprint-newer", "9.9.9+newer",
      "human", Date.now() + 60_000, "completed", 1, 1, 1],
  );
  qualityDatabase()?.run(
    `INSERT INTO telemetry_events (event_key,run_id,host,session_hash,turn_seq,ts,kind,source,
      tool_name,entity_type,entity_hash,success,input_tokens,output_tokens,estimated_tokens,
      duration_ms,item_count,value,release_fingerprint,version,run_class,
      runtime_release_fingerprint,runtime_version,rank,score_bucket)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ["event-mismatched-newer", "run-mismatched-newer", "copilot", "hash-newer", 1,
      Date.now() + 60_000, "tool", "host", "brain_search", "", "", 1, 0, 0, 0, 0, 0, 0,
      "fingerprint-newer", "9.9.9+newer", "human", "stale-fingerprint", "0.0.0+stale", 0, 0],
  );

  const quality = qualitySummary(7);
  // The newest release has a completed run, but every one of its runs is release-mismatched, so the
  // rates must fall back to the newest release that actually has a comparable sample.
  expect(quality.latestVersion).toBe("9.9.9+newer");
  expect(quality.sampleVersion).toBe(releaseVersion);
  expect(quality.coherentRuns).toBe(1);
  expect(quality.mixedRuntimeRuns).toBe(0);
});

test("quality verdict reports no receipt compliance issue without samples", () => {
  const empty = telemetryQualityVerdict(
    { ...qualitySummary(7), runs: 0, skillReceiptChecks: 0, skillReceiptComplianceRate: 0,
      latestVersion: "1.0.0", sampleVersion: "1.0.0" },
    { version: "1.0.0", engineTransports: [], parity: { checks: 0, mismatches: 0 } } as never,
  );
  expect(empty.issues.some((issue) => issue.includes("skill receipts"))).toBe(false);
  expect(empty.issues.some((issue) => issue.includes("complete skill receipts"))).toBe(false);
  expect(empty.status).toBe("insufficient_data");
});
