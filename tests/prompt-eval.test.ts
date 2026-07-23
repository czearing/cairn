import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { capturePromptEvidence } from "../src/prompt-eval/evidence";
import { runAssertions } from "../src/prompt-eval/assertions";
import {
  appendBenchmarkReminder,
  benchmarkReminder,
} from "../src/prompt-eval/reminder-profile";
import {
  beginBenchmarkRun,
  finishBenchmarkRun,
  initializeBenchmarkDatabase,
  recordBenchmarkContext,
  recordBenchmarkTool,
  submitBenchmarkResult,
} from "../src/prompt-eval/benchmark-record";
import { evaluatePrompt } from "../src/prompt-eval/score";
import { prepareBenchmarkRunDatabase } from "../src/prompt-eval/benchmark-runner";
import type { PromptBenchmark, PromptRunEvidence } from "../src/prompt-eval/types";

const evidence = (overrides: Partial<PromptRunEvidence> = {}): PromptRunEvidence => ({
  caseId: "recursive-research",
  host: "copilot",
  trial: 1,
  promptTokens: 2300,
  completed: true,
  workflowPassed: true,
  skillSelected: true,
  selectedSkillIds: ["skill-a"],
  brainSearched: true,
  searchBeforeWrite: true,
  rootCreated: true,
  rootSynthesized: true,
  rootSynthesizedLast: true,
  createdNodes: 20,
  answeredNodes: 20,
  citedAnswers: 20,
  deepestLevel: 4,
  returnedNodes: 4,
  usedReturnedNodes: 3,
  taskAssertionSet: "assertions-v1",
  taskAssertionsPassed: 3,
  taskAssertionsTotal: 3,
  toolFailures: 0,
  stopNudges: 1,
  unexpectedEvents: 0,
  ...overrides,
});

const benchmark = (name: string, runs: PromptRunEvidence[]): PromptBenchmark => ({
  name,
  promptHash: `${name}-hash`,
  minimumTrials: 1,
  requireQualityImprovement: false,
  runs,
});

test("accepts token savings only after every quality gate passes", () => {
  const result = evaluatePrompt(
    benchmark("baseline", [evidence()]),
    benchmark("candidate", [evidence({ promptTokens: 500 })]),
  );
  expect(result.accepted).toBe(true);
  expect(result.safeTokenReduction).toBeCloseTo(0.783, 3);
});

test("rejects candidates that do not reduce measured tokens", () => {
  const result = evaluatePrompt(
    benchmark("baseline", [evidence({ promptTokens: 500 })]),
    benchmark("candidate", [evidence({ promptTokens: 500 })]),
  );
  expect(result.accepted).toBe(false);
  expect(result.safeTokenReduction).toBeNull();
  expect(result.failures).toContainEqual(expect.objectContaining({
    gate: "tokenReduction",
  }));
});

test("does not hardcode task-size node or depth targets", () => {
  const result = evaluatePrompt(
    benchmark("baseline", [evidence()]),
    benchmark("candidate", [evidence({
      promptTokens: 300,
      createdNodes: 3,
      answeredNodes: 3,
      citedAnswers: 3,
      deepestLevel: 1,
    })]),
  );
  expect(result.accepted).toBe(true);
  expect(result.safeTokenReduction).toBeCloseTo(0.87, 2);
});

test("rejects missing task assertions and uncited answers", () => {
  const result = evaluatePrompt(
    benchmark("baseline", [evidence()]),
    benchmark("candidate", [evidence({
      promptTokens: 300,
      taskAssertionsPassed: 2,
      citedAnswers: 19,
    })]),
  );
  expect(result.accepted).toBe(false);
  expect(result.failures.map((failure) => failure.gate)).toEqual(
    expect.arrayContaining(["taskAssertions", "citationCoverage"])
  );
});

test("requires matching isolated cases for both hosts", () => {
  const baseline = benchmark("baseline", [
    evidence(),
    evidence({ host: "claude" }),
  ]);
  const result = evaluatePrompt(baseline, benchmark("candidate", [evidence({ promptTokens: 500 })]));
  expect(result.accepted).toBe(false);
  expect(result.failures).toContainEqual(expect.objectContaining({
    host: "claude",
    gate: "runPresent",
  }));
});

test("extracts quality from structured isolated events without reading prose", () => {
  const path = join(tmpdir(), `cairn-prompt-evidence-${randomUUID()}.db`);
  const sessionId = "isolated-session";
  const db = new Database(path);
  db.run("CREATE TABLE prompt_benchmark_meta(isolated INTEGER NOT NULL)");
  db.run("INSERT INTO prompt_benchmark_meta VALUES (1)");
  db.run(`CREATE TABLE host_events(
    event_key TEXT PRIMARY KEY,host TEXT,hook_type TEXT,session_id TEXT,turn_id TEXT,
    agent_id TEXT,tool_call_id TEXT,tool_name TEXT,event_timestamp TEXT,raw_json TEXT,recorded_ts INTEGER
  )`);
  db.run(`CREATE TABLE quality_runs(
    run_id TEXT PRIMARY KEY,host TEXT,session_hash TEXT,turn_seq INTEGER,injected_tokens INTEGER,
    completed INTEGER,workflow_passed INTEGER,tool_failures INTEGER,stop_nudges INTEGER
  )`);
  db.run("CREATE TABLE quality_events(run_id TEXT,kind TEXT)");
  const add = (index: number, tool: string, args: object, result: object) => {
    const raw = JSON.stringify({ sessionId, toolName: tool, toolArgs: args, toolResult: result });
    db.query("INSERT INTO host_events VALUES (?,?,?,?,?,?,?,?,?,?,?)").run(
      String(index), "copilot", "post-tool", sessionId, "", "", String(index),
      tool, "", raw, index,
    );
  };
  add(1, "cairn-skill_select", { ids: ["skill-a"] }, { ok: true });
  add(2, "cairn-brain_search", { query: "root" }, [{ id: "prior" }]);
  add(3, "cairn-brain_create", { text: "root" }, { id: "root" });
  add(4, "cairn-brain_create", { text: "child", edges: ["root", "prior"] }, { id: "child" });
  add(5, "cairn-brain_mutate", { id: "child", answer: "a", citation: "https://example.com" }, { id: "child" });
  add(6, "cairn-brain_mutate", { id: "root", answer: "a", citation: "https://example.com" }, { id: "root" });
  const sessionHash = createHash("sha256").update(sessionId).digest("hex").slice(0, 16);
  db.query("INSERT INTO quality_runs VALUES (?,?,?,?,?,?,?,?,?)")
    .run("run", "copilot", sessionHash, 1, 500, 1, 1, 0, 0);
  db.close();

  expect(capturePromptEvidence({
    dbPath: path,
    host: "copilot",
    sessionId,
    caseId: "structured",
    trial: 1,
    taskAssertionSet: "assertions-v1",
    taskAssertionsPassed: 2,
    taskAssertionsTotal: 2,
  })).toMatchObject({
    promptTokens: 500,
    skillSelected: true,
    selectedSkillIds: ["skill-a"],
    searchBeforeWrite: true,
    rootSynthesizedLast: true,
    createdNodes: 2,
    answeredNodes: 2,
    citedAnswers: 2,
    deepestLevel: 1,
    returnedNodes: 1,
    usedReturnedNodes: 1,
  });
});

test("captures isolated agent runs directly from benchmark MCP events", () => {
    const root = join(tmpdir(), `cairn-prompt-direct-${randomUUID()}`);
    const path = join(root, "benchmark.db");
    const resultPath = join(root, "result.json");
    mkdirSync(root);
    initializeBenchmarkDatabase(path, "direct", "prompt-hash");
    beginBenchmarkRun(path, {
      sessionId: "direct-session",
      host: "copilot",
      caseId: "direct",
      trial: 1,
      promptTokens: 400,
    });

    const previous = {
      db: process.env.CAIRN_DB_PATH,
      session: process.env.CAIRN_PROMPT_BENCHMARK_SESSION,
      result: process.env.CAIRN_PROMPT_BENCHMARK_RESULT,
    };
    process.env.CAIRN_DB_PATH = path;
    process.env.CAIRN_PROMPT_BENCHMARK_SESSION = "direct-session";
    process.env.CAIRN_PROMPT_BENCHMARK_RESULT = resultPath;
    const record = (toolName: string, args: unknown, result: unknown) =>
      recordBenchmarkTool({ toolName, args, result, success: true });
    try {
      record("skill_select", { ids: ["skill-a"] }, { selected: [{ id: "skill-a" }] });
      record("brain_search", { query: "task" }, [{ id: "prior" }]);
      record("brain_create", { text: "What is the root?" }, { id: "root" });
      record("brain_create", { text: "What is unresolved?", edges: ["root", "prior"] }, { id: "child" });
      record("brain_mutate", { id: "child", answer: "done", citation: "https://example.com" }, { id: "child" });
      record("brain_mutate", { id: "root", answer: "done", citation: "https://example.com" }, { id: "root" });
      recordBenchmarkContext("x".repeat(80));
      submitBenchmarkResult({ status: "complete" });
      finishBenchmarkRun(path, {
        sessionId: "direct-session",
        completed: true,
        workflowPassed: true,
        assertionSet: "assertions",
        assertionsPassed: 1,
        assertionsTotal: 1,
      });
      expect(capturePromptEvidence({
        dbPath: path,
        host: "copilot",
        sessionId: "direct-session",
        caseId: "direct",
        trial: 1,
        taskAssertionSet: "assertions",
        taskAssertionsPassed: 1,
        taskAssertionsTotal: 1,
      })).toMatchObject({
        promptTokens: expect.any(Number),
        selectedSkillIds: ["skill-a"],
        rootSynthesizedLast: true,
        answeredNodes: 2,
        citedAnswers: 2,
        deepestLevel: 1,
        usedReturnedNodes: 1,
      });
      expect(capturePromptEvidence({
        dbPath: path,
        host: "copilot",
        sessionId: "direct-session",
        caseId: "direct",
        trial: 1,
        taskAssertionSet: "assertions",
        taskAssertionsPassed: 1,
        taskAssertionsTotal: 1,
      }).promptTokens).toBeGreaterThan(420);
    } finally {
      if (previous.db == null) delete process.env.CAIRN_DB_PATH;
      else process.env.CAIRN_DB_PATH = previous.db;
      if (previous.session == null) delete process.env.CAIRN_PROMPT_BENCHMARK_SESSION;
      else process.env.CAIRN_PROMPT_BENCHMARK_SESSION = previous.session;
      if (previous.result == null) delete process.env.CAIRN_PROMPT_BENCHMARK_RESULT;
      else process.env.CAIRN_PROMPT_BENCHMARK_RESULT = previous.result;
      rmSync(root, { recursive: true, force: true });
    }
});

test("benchmark reminder profiles add the delivered hook context to measured tokens", () => {
  const root = join(tmpdir(), `cairn-reminder-profile-${randomUUID()}`);
  const profile = join(root, "profile");
  const path = join(root, "benchmark.db");
  mkdirSync(profile, { recursive: true });
  writeFileSync(join(profile, "search-results.md"), "Use the returned evidence.");
  initializeBenchmarkDatabase(path, "reminders", "prompt-hash");
  beginBenchmarkRun(path, {
    sessionId: "reminder-session",
    host: "copilot",
    caseId: "reminders",
    trial: 1,
    promptTokens: 100,
  });

  const previous = {
    db: process.env.CAIRN_DB_PATH,
    session: process.env.CAIRN_PROMPT_BENCHMARK_SESSION,
    dir: process.env.CAIRN_PROMPT_BENCHMARK_DIR,
  };
  process.env.CAIRN_DB_PATH = path;
  process.env.CAIRN_PROMPT_BENCHMARK_SESSION = "reminder-session";
  process.env.CAIRN_PROMPT_BENCHMARK_DIR = profile;
  try {
    const reminder = benchmarkReminder("brain_search", { query: "x" });
    const delivered = appendBenchmarkReminder({
      content: [{ type: "text", text: "[]" }],
    }, reminder);
    expect(reminder).toContain("Use the returned evidence.");
    expect(delivered.content).toHaveLength(2);
    const db = new Database(path, { readonly: true });
    const row = db.query("SELECT context_tokens FROM prompt_benchmark_runs")
      .get() as { context_tokens: number };
    db.close();
    expect(row.context_tokens).toBeGreaterThan(100);
  } finally {
    if (previous.db == null) delete process.env.CAIRN_DB_PATH;
    else process.env.CAIRN_DB_PATH = previous.db;
    if (previous.session == null) delete process.env.CAIRN_PROMPT_BENCHMARK_SESSION;
    else process.env.CAIRN_PROMPT_BENCHMARK_SESSION = previous.session;
    if (previous.dir == null) delete process.env.CAIRN_PROMPT_BENCHMARK_DIR;
    else process.env.CAIRN_PROMPT_BENCHMARK_DIR = previous.dir;
    rmSync(root, { recursive: true, force: true });
  }
});

test("prepares every benchmark trial from an independent source snapshot", () => {
  const root = join(tmpdir(), `cairn-prompt-isolation-${randomUUID()}`);
  mkdirSync(root);
  const sourcePath = join(root, "source.db");
  const firstPath = join(root, "first.db");
  const secondPath = join(root, "second.db");
  const source = new Database(sourcePath);
  source.run("CREATE TABLE fixture(value TEXT)");
  source.run("INSERT INTO fixture VALUES ('source')");
  const snapshot = source.serialize();
  source.close();
  try {
    prepareBenchmarkRunDatabase(firstPath, snapshot, "first", "hash");
    const first = new Database(firstPath);
    first.run("INSERT INTO fixture VALUES ('trial-write')");
    first.close();

    prepareBenchmarkRunDatabase(secondPath, snapshot, "second", "hash");
    const second = new Database(secondPath, { readonly: true });
    const values = second.query("SELECT value FROM fixture ORDER BY rowid").all();
    second.close();
    expect(values).toEqual([{ value: "source" }]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("refuses to inspect the live Cairn database", () => {
  expect(() => capturePromptEvidence({
    dbPath: join(homedir(), ".cairn", "cairn.db"),
    host: "copilot",
    sessionId: "live",
    caseId: "forbidden",
    trial: 1,
    taskAssertionSet: "assertions-v1",
    taskAssertionsPassed: 0,
    taskAssertionsTotal: 0,
  })).toThrow("refuses the live Cairn database");
});

test("executes exact hashed task assertions instead of accepting a claimed score", () => {
  const root = join(tmpdir(), `cairn-prompt-assertions-${randomUUID()}`);
  mkdirSync(root);
  writeFileSync(join(root, "result.txt"), "correct");
  const manifest = join(root, "assertions.json");
  writeFileSync(manifest, JSON.stringify({ assertions: [
    { type: "fileExists", path: "result.txt" },
    { type: "fileEquals", path: "result.txt", expected: "correct" },
    { type: "fileEquals", path: "result.txt", expected: "wrong" },
  ] }));
  expect(runAssertions(manifest, root)).toMatchObject({
    passed: 2,
    total: 3,
    failures: ["3:fileEquals:content differs"],
  });
  expect(runAssertions(manifest, root).assertionSet).toHaveLength(24);
});

test("rejects changed skill selection and weaker brain reuse", () => {
  const result = evaluatePrompt(
    benchmark("baseline", [evidence()]),
    benchmark("candidate", [evidence({
      promptTokens: 300,
      selectedSkillIds: ["different-skill"],
      usedReturnedNodes: 1,
    })]),
  );
  expect(result.accepted).toBe(false);
  expect(result.failures.map((failure) => failure.gate)).toEqual(
    expect.arrayContaining(["selectedSkillIds", "searchToUse"])
  );
});

test("compares brain reuse across matched trials instead of noisy individual runs", () => {
  const baselineRuns = [
    evidence({ trial: 1, returnedNodes: 1, usedReturnedNodes: 1 }),
    evidence({ trial: 2, returnedNodes: 9, usedReturnedNodes: 0 }),
  ];
  const candidateRuns = [
    evidence({ trial: 1, returnedNodes: 3, usedReturnedNodes: 2, promptTokens: 500 }),
    evidence({ trial: 2, returnedNodes: 7, usedReturnedNodes: 2, promptTokens: 500 }),
  ];
  const result = evaluatePrompt(
    { ...benchmark("baseline", baselineRuns), minimumTrials: 2 },
    { ...benchmark("candidate", candidateRuns), minimumTrials: 2 },
  );
  expect(result.accepted).toBe(true);
});

test("rejects benchmark groups without the configured repeat count", () => {
  const runs = [evidence({ trial: 1 }), evidence({ trial: 2 })];
  const result = evaluatePrompt(
    { ...benchmark("baseline", runs), minimumTrials: 3 },
    { ...benchmark("candidate", runs), minimumTrials: 3 },
  );
  expect(result.accepted).toBe(false);
  expect(result.failures).toContainEqual(expect.objectContaining({
    gate: "minimumTrials",
    baseline: 3,
    candidate: 2,
  }));
});

test("requires a declared quality improvement when requested", () => {
  const baseline = {
    ...benchmark("baseline", [evidence({ stopNudges: 2 })]),
    requireQualityImprovement: true,
  };
  const improved = {
    ...benchmark("candidate", [evidence({
      promptTokens: 500,
      stopNudges: 0,
    })]),
    requireQualityImprovement: true,
  };
  const result = evaluatePrompt(baseline, improved);
  expect(result.accepted).toBe(true);
  expect(result.qualityImprovements).toBe(2);
});

test("rejects token savings without a measured quality improvement", () => {
  const baseline = {
    ...benchmark("baseline", [evidence()]),
    requireQualityImprovement: true,
  };
  const candidate = {
    ...benchmark("candidate", [evidence({ promptTokens: 500 })]),
    requireQualityImprovement: true,
  };
  const result = evaluatePrompt(baseline, candidate);
  expect(result.accepted).toBe(false);
  expect(result.failures.map((failure) => failure.gate)).toContain("qualityImprovements");
});
