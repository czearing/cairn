import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { releaseVersion } from "../src/core/release";

test("usage telemetry is off without an explicit local opt-in", () => {
  const dbPath = join(tmpdir(), `cairn-usage-opt-out-${randomUUID()}.db`);
  const configPath = join(tmpdir(), `cairn-usage-opt-out-${randomUUID()}.json`);
  const result = spawnSync(process.execPath, [
    "-e",
    `import { recordTelemetry } from "./src/core/telemetry"; console.log(recordTelemetry({kind:"tool_transport",source:"test"}));`,
  ], {
    cwd: join(import.meta.dir, ".."),
    env: {
      ...process.env,
      CAIRN_USAGE: "",
      CAIRN_CONFIG_PATH: configPath,
      CAIRN_DB_PATH: dbPath,
    },
  });
  expect(result.status).toBe(0);
  expect(result.stdout.toString().trim()).toBe("false");
  expect(() => new Database(dbPath, { readonly: true })).toThrow();
});

test("usage events store measurements without user content", async () => {
  const {
    beginTelemetryRun,
    finishTelemetryRun,
    promptFingerprint,
    recordTelemetry: recordUsage,
    telemetrySummary: usageSummary,
  } =
    await import("../src/core/telemetry");
  const marker = `private-${randomUUID()}`;
  const run = { host: "copilot" as const, sessionId: marker, turnSeq: 3 };
  beginTelemetryRun({
    ...run,
    promptHash: promptFingerprint("usage-test"),
    catalogVersion: "catalog",
    injectedChars: 9372,
  });
  expect(recordUsage({
    kind: "context",
    source: "user-prompt",
    host: "copilot",
    sessionId: marker,
    turnSeq: 3,
    contextChars: 9372,
    eventKey: `context-${marker}`,
    releaseFingerprint: "release-human",
    version: "1.2.3",
    runClass: "human",
  })).toBe(true);
  expect(recordUsage({
    kind: "tool_transport",
    source: "mcp",
    toolName: "brain_search",
    inputChars: 80,
    outputChars: 1200,
    durationMs: 15,
    itemCount: 5,
    success: true,
    eventKey: `tool-${marker}`,
    releaseFingerprint: "release-human",
    version: "1.2.3",
    runClass: "human",
  })).toBe(true);
  finishTelemetryRun({
    ...run,
    completed: true,
    workflowPassed: true,
    skillUsed: false,
    brainUsed: false,
    stopNudges: 0,
  });

  const db = new Database(process.env.CAIRN_DB_PATH!);
  const schema = db.query("PRAGMA table_info(telemetry_events)").all() as { name: string }[];
  const stored = db.query("SELECT * FROM telemetry_events WHERE source='user-prompt' ORDER BY ts DESC LIMIT 1")
    .get() as Record<string, unknown>;
  db.close();

  expect(schema.map((column) => column.name)).not.toContain("content");
  expect(JSON.stringify(stored)).not.toContain(marker);
  expect(typeof stored.session_hash).toBe("string");
  expect(String(stored.session_hash)).toHaveLength(16);
  expect(stored.estimated_tokens).toBe(2343);
  expect(String(stored.release_fingerprint)).toHaveLength(24);
  expect(stored.version).toBe(releaseVersion);
  expect(stored.run_class).toBe("human");
  const summary = usageSummary(1);
  expect(summary.groups.some((group) =>
    group.source === "user-prompt" && group.estimatedTokens >= 2343
  )).toBe(true);
  expect(summary.impact).toMatchObject({
    currentPromptTokens: 2343,
    contextTokens: expect.any(Number),
    toolTokens: expect.any(Number),
    prompts: expect.any(Number),
  });
  expect(summary.impact.measuredTokensPerPrompt).toBeGreaterThan(0);
  expect(summary.impact).toMatchObject({
    releaseFingerprint: expect.stringMatching(/^[0-9a-f]{24}$/),
    version: releaseVersion,
    runClass: "human",
  });
});

test("usage summaries exclude benchmark traffic and older releases", async () => {
  const {
    beginTelemetryRun,
    finishTelemetryRun,
    promptFingerprint,
    releaseFingerprint,
    recordTelemetry: recordUsage,
    telemetrySummary: usageSummary,
  } =
    await import("../src/core/telemetry");
  const key = randomUUID();
  const old = { host: "copilot" as const, sessionId: `${key}-old`, turnSeq: 1 };
  const current = { host: "copilot" as const, sessionId: `${key}-current`, turnSeq: 1 };
  const oldPrompt = promptFingerprint("old");
  const currentPrompt = promptFingerprint("current");
  beginTelemetryRun({ ...old, promptHash: oldPrompt, catalogVersion: "catalog", injectedChars: 400 });
  recordUsage({
    kind: "context", source: "user-prompt", contextChars: 400,
    eventKey: `${key}-old`, ...old,
  });
  finishTelemetryRun({
    ...old, completed: true, workflowPassed: true, skillUsed: false, brainUsed: false, stopNudges: 0,
  });
  beginTelemetryRun({
    ...current, promptHash: currentPrompt, catalogVersion: "catalog", injectedChars: 800,
    ts: Date.now() + 1,
  });
  recordUsage({
    kind: "context", source: "user-prompt", contextChars: 800,
    eventKey: `${key}-current`, ...current, ts: Date.now() + 1,
  });
  finishTelemetryRun({
    ...current, completed: true, workflowPassed: true, skillUsed: false, brainUsed: false, stopNudges: 0,
  });
  const previousBenchmark = process.env.CAIRN_PROMPT_BENCHMARK_SESSION;
  process.env.CAIRN_PROMPT_BENCHMARK_SESSION = `${key}-benchmark`;
  try {
    const benchmark = { host: "copilot" as const, sessionId: `${key}-benchmark`, turnSeq: 1 };
    beginTelemetryRun({
      ...benchmark,
      promptHash: currentPrompt,
      catalogVersion: "catalog",
      injectedChars: 4000,
      ts: Date.now() + 2,
    });
    recordUsage({
      kind: "context", source: "user-prompt", contextChars: 4000,
      eventKey: `${key}-benchmark`, ...benchmark, ts: Date.now() + 2,
    });
    finishTelemetryRun({
      ...benchmark,
      completed: true,
      workflowPassed: true,
      skillUsed: false,
      brainUsed: false,
      stopNudges: 0,
    });
  } finally {
    if (previousBenchmark == null) delete process.env.CAIRN_PROMPT_BENCHMARK_SESSION;
    else process.env.CAIRN_PROMPT_BENCHMARK_SESSION = previousBenchmark;
  }
  const summary = usageSummary(1);
  expect(summary.impact).toMatchObject({
    releaseFingerprint: releaseFingerprint(currentPrompt, "catalog"),
    version: releaseVersion,
    runClass: "human",
    currentPromptTokens: 200,
  });
  expect(summary.totals.estimatedTokens).toBe(200);
});

test("quality run identity backfills usage release metadata", async () => {
  const { recordTelemetry: recordUsage, beginTelemetryRun: beginQualityRun,
    promptFingerprint, releaseFingerprint, telemetryRunId } = await import("../src/core/telemetry");
  const sessionId = `release-backfill-${randomUUID()}`;
  recordUsage({
    kind: "context",
    source: "user-prompt",
    host: "copilot",
    sessionId,
    turnSeq: 1,
    contextChars: 100,
    eventKey: sessionId,
  });
  beginQualityRun({
    host: "copilot",
    sessionId,
    turnSeq: 1,
    promptHash: promptFingerprint("release prompt"),
    catalogVersion: "release catalog",
    injectedChars: 100,
  });
  const db = new Database(process.env.CAIRN_DB_PATH!, { readonly: true });
  const row = db.query(`SELECT release_fingerprint,version,run_class
    FROM telemetry_events WHERE run_id=? AND source='user-prompt' LIMIT 1`)
    .get(telemetryRunId({ host: "copilot", sessionId, turnSeq: 1 }));
  db.close();
  expect(row).toEqual({
    release_fingerprint: releaseFingerprint(
      promptFingerprint("release prompt"),
      "release catalog",
    ),
    version: releaseVersion,
    run_class: "human",
  });
});

test("usage event keys make hook telemetry idempotent", async () => {
  const { recordTelemetry: recordUsage } = await import("../src/core/telemetry");
  const key = `duplicate-${randomUUID()}`;
  expect(recordUsage({ kind: "context", source: "test", contextChars: 100, eventKey: key })).toBe(true);
  expect(recordUsage({ kind: "context", source: "test", contextChars: 999, eventKey: key })).toBe(true);
  const db = new Database(process.env.CAIRN_DB_PATH!);
  const rows = db.query("SELECT context_chars FROM telemetry_events WHERE source='test' ORDER BY ts DESC LIMIT 2")
    .all() as { context_chars: number }[];
  db.close();
  expect(rows).toEqual([{ context_chars: 100 }]);
});

test("Copilot user-prompt records only injected context metrics", () => {
  const dbPath = join(tmpdir(), `cairn-usage-hook-${randomUUID()}.db`);
  const hook = join(import.meta.dir, "..", "src", "hosts", "copilot-cli", "hook.ts");
  const result = spawnSync(process.execPath, [hook, "user-prompt"], {
    input: JSON.stringify({
      sessionId: "usage-session",
      prompt: "Sensitive prompt text must not be copied.",
      timestamp: "usage-event",
    }),
    env: { ...process.env, CAIRN_DB_PATH: dbPath, CAIRN_SKILLS: "1" },
  });
  expect(result.status).toBe(0);
  expect(spawnSync(process.execPath, [hook, "session-start"], {
    input: JSON.stringify({ sessionId: "usage-session", timestamp: "usage-session-start" }),
    env: { ...process.env, CAIRN_DB_PATH: dbPath, CAIRN_SKILLS: "1" },
  }).status).toBe(0);

  const db = new Database(dbPath);
  const event = db.query("SELECT source,context_chars,session_hash FROM telemetry_events WHERE source='user-prompt'").get() as {
    source: string;
    context_chars: number;
    session_hash: string;
  };
  const serialized = JSON.stringify(db.query("SELECT * FROM telemetry_events").all());
  const sessionStarts = db.query("SELECT COUNT(*) AS count FROM telemetry_events WHERE source='session-start'").get();
  db.close();
  expect(event.source).toBe("user-prompt");
  expect(event.context_chars).toBeGreaterThan(1000);
  expect(event.session_hash).toHaveLength(16);
  expect(sessionStarts).toEqual({ count: 1 });
  expect(serialized).not.toContain("Sensitive prompt");
  rmSync(dbPath, { force: true });
});

test("usage CLI emits machine-readable aggregates", () => {
  const result = spawnSync(process.execPath, ["src/cli.ts", "telemetry", "--days=1", "--json"], {
    cwd: join(import.meta.dir, ".."),
    env: { ...process.env },
  });
  expect(result.status).toBe(0);
  const report = JSON.parse(result.stdout.toString()) as {
    totals: { events: number };
    impact: { currentPromptTokens: number };
    quality: unknown;
    groups: unknown[];
  };
  expect(report.totals.events).toBeGreaterThan(0);
  expect(report.impact.currentPromptTokens).toBeGreaterThan(0);
  expect(report.quality).toBeDefined();
  expect(Array.isArray(report.groups)).toBe(true);
});

test("usage CLI prints decision metrics directly", () => {
  const result = spawnSync(process.execPath, ["src/cli.ts", "telemetry", "--days=1"], {
    cwd: join(import.meta.dir, ".."),
    env: { ...process.env },
  });
  const output = result.stdout.toString();
  expect(result.status).toBe(0);
  expect(output).toContain("fixed/message");
  expect(output).toContain("release ");
  expect(output).toContain("measured/message");
  expect(output).toContain("context");
  expect(output).toContain("tools");
  expect(output).toContain("Quality & reuse");
  expect(output).toContain("cross-session reuse");
});
