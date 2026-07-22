import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { capturePromptEvidence } from "../src/prompt-eval/evidence";
import { runAssertions } from "../src/prompt-eval/assertions";
import { evaluatePrompt } from "../src/prompt-eval/score";
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
  maxDepth: 4,
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
  minimumTrials: 1,
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

test("rejects a cheaper prompt that weakens recursive decomposition", () => {
  const result = evaluatePrompt(
    benchmark("baseline", [evidence()]),
    benchmark("candidate", [evidence({ promptTokens: 300, maxDepth: 2 })]),
  );
  expect(result.accepted).toBe(false);
  expect(result.safeTokenReduction).toBeNull();
  expect(result.failures.map((failure) => failure.gate)).toContain("maxDepth");
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
    maxDepth: 1,
    returnedNodes: 1,
    usedReturnedNodes: 1,
  });
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
    expect.arrayContaining(["selectedSkillIds", "usedReturnedNodes", "searchToUse"])
  );
});

test("rejects benchmark groups without the configured repeat count", () => {
  const runs = [evidence({ trial: 1 }), evidence({ trial: 2 })];
  const result = evaluatePrompt(
    { name: "baseline", minimumTrials: 3, runs },
    { name: "candidate", minimumTrials: 3, runs },
  );
  expect(result.accepted).toBe(false);
  expect(result.failures).toContainEqual(expect.objectContaining({
    gate: "minimumTrials",
    baseline: 3,
    candidate: 2,
  }));
});
