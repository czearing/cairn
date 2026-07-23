import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

test("usage telemetry is off without an explicit local opt-in", () => {
  const dbPath = join(tmpdir(), `cairn-usage-opt-out-${randomUUID()}.db`);
  const configPath = join(tmpdir(), `cairn-usage-opt-out-${randomUUID()}.json`);
  const result = spawnSync(process.execPath, [
    "-e",
    `import { recordUsage } from "./src/core/usage"; console.log(recordUsage({eventKind:"tool",source:"test"}));`,
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
  const { recordUsage, usageSummary } = await import("../src/core/usage");
  const marker = `private-${randomUUID()}`;
  expect(recordUsage({
    eventKind: "context",
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
    eventKind: "tool",
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

  const db = new Database(process.env.CAIRN_DB_PATH!);
  const schema = db.query("PRAGMA table_info(usage_events)").all() as { name: string }[];
  const stored = db.query("SELECT * FROM usage_events WHERE source = 'user-prompt' ORDER BY id DESC LIMIT 1")
    .get() as Record<string, unknown>;
  db.close();

  expect(schema.map((column) => column.name)).not.toContain("content");
  expect(JSON.stringify(stored)).not.toContain(marker);
  expect(typeof stored.session_hash).toBe("string");
  expect(String(stored.session_hash)).toHaveLength(16);
  expect(stored.estimated_tokens).toBe(2343);
  expect(stored.release_fingerprint).toBe("release-human");
  expect(stored.version).toBe("1.2.3");
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
    releaseFingerprint: "release-human",
    version: "1.2.3",
    runClass: "human",
  });
});

test("usage summaries exclude benchmark traffic and older releases", async () => {
  const { recordUsage, usageSummary } = await import("../src/core/usage");
  const key = randomUUID();
  recordUsage({
    eventKind: "context", source: "user-prompt", contextChars: 400,
    eventKey: `${key}-old`, releaseFingerprint: "old", version: "1", runClass: "human",
  });

  recordUsage({
    eventKind: "context", source: "user-prompt", contextChars: 800,
    eventKey: `${key}-current`, releaseFingerprint: "current", version: "2", runClass: "human",
    ts: Date.now() + 1,
  });
  recordUsage({
    eventKind: "context", source: "user-prompt", contextChars: 4000,
    eventKey: `${key}-benchmark`, releaseFingerprint: "current", version: "2",
    runClass: "benchmark", ts: Date.now() + 2,
  });
  const summary = usageSummary(1);
  expect(summary.impact).toMatchObject({
    releaseFingerprint: "current",
    version: "2",
    runClass: "human",
    currentPromptTokens: 200,
    toolTelemetryMissing: true,
  });
  expect(summary.totals.estimatedTokens).toBe(200);
});

test("quality run identity backfills usage release metadata", async () => {
  const { recordUsage } = await import("../src/core/usage");
  const { beginQualityRun, promptFingerprint, releaseFingerprint } =
    await import("../src/core/quality-record");
  const sessionId = `release-backfill-${randomUUID()}`;
  recordUsage({
    eventKind: "context",
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
    FROM usage_events WHERE source='user-prompt' ORDER BY id DESC LIMIT 1`).get();
  db.close();
  expect(row).toEqual({
    release_fingerprint: releaseFingerprint(
      promptFingerprint("release prompt"),
      "release catalog",
    ),
    version: "0.1.0",
    run_class: "human",
  });
});

test("usage event keys make hook telemetry idempotent", async () => {
  const { recordUsage } = await import("../src/core/usage");
  const key = `duplicate-${randomUUID()}`;
  expect(recordUsage({ eventKind: "context", source: "test", contextChars: 100, eventKey: key })).toBe(true);
  expect(recordUsage({ eventKind: "context", source: "test", contextChars: 999, eventKey: key })).toBe(true);
  const db = new Database(process.env.CAIRN_DB_PATH!);
  const rows = db.query("SELECT context_chars FROM usage_events WHERE source = 'test' ORDER BY id DESC LIMIT 2")
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
  const event = db.query("SELECT source,context_chars,session_hash FROM usage_events WHERE source='user-prompt'").get() as {
    source: string;
    context_chars: number;
    session_hash: string;
  };
  const serialized = JSON.stringify(db.query("SELECT * FROM usage_events").all());
  const sessionStarts = db.query("SELECT COUNT(*) AS count FROM usage_events WHERE source='session-start'").get();
  db.close();
  expect(event.source).toBe("user-prompt");
  expect(event.context_chars).toBeGreaterThan(1000);
  expect(event.session_hash).toHaveLength(16);
  expect(sessionStarts).toEqual({ count: 1 });
  expect(serialized).not.toContain("Sensitive prompt");
  rmSync(dbPath, { force: true });
});

test("usage CLI emits machine-readable aggregates", () => {
  const result = spawnSync(process.execPath, ["src/cli.ts", "usage", "--days=1", "--json"], {
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
  const result = spawnSync(process.execPath, ["src/cli.ts", "usage", "--days=1"], {
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
