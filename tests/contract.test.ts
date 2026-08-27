import { afterAll, beforeAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import {
  clearContract,
  contractDeclared,
  contractExhausted,
  contractStopReason,
  declareContract,
  noteContractNudge,
  readContract,
  recordObservedRun,
  satisfyCriterion,
} from "../src/hosts/copilot-cli/contract";

beforeAll(() => {
  process.env.CAIRN_REVIEWER_MOCK = "approve";
});

afterAll(() => {
  delete process.env.CAIRN_REVIEWER_MOCK;
});

test("declareContract sets up initial criteria and prevents empty declaration", () => {
  const sessionId = randomUUID();
  try {
    expect(contractDeclared(sessionId)).toBe(false);
    expect(declareContract([], sessionId)).toEqual({
      error: "declare at least one criterion describing what done means",
    });
    expect(declareContract(["  ", ""], sessionId)).toEqual({
      error: "declare at least one criterion describing what done means",
    });

    const res = declareContract(["bun test", "all endpoints documented"], sessionId);
    expect(res.criteria).toBeDefined();
    expect(res.criteria?.length).toBe(2);
    expect(contractDeclared(sessionId)).toBe(true);

    const contract = readContract(sessionId);
    expect(contract?.criteria.map((c) => c.check)).toEqual([
      "bun test",
      "all endpoints documented",
    ]);
    expect(contract?.criteria.every((c) => !c.passed)).toBe(true);
  } finally {
    clearContract(sessionId);
  }
});

test("declareContract ratchets: appends new criteria and ignores duplicates without resetting existing state", () => {
  const sessionId = randomUUID();
  try {
    declareContract(["bun test", "lint clean"], sessionId);
    satisfyCriterion("lint clean", "eslint passed with 0 warnings", sessionId);

    let contract = readContract(sessionId);
    expect(contract?.criteria.find((c) => c.check === "lint clean")?.passed).toBe(true);

    // Appending a new criterion and duplicate existing ones (with different casing/whitespace)
    const res = declareContract(["LINT CLEAN", "  bun test  ", "deploy verified"], sessionId);
    expect(res.criteria?.length).toBe(3);

    contract = readContract(sessionId);
    expect(contract?.criteria.map((c) => c.check)).toEqual([
      "bun test",
      "lint clean",
      "deploy verified",
    ]);
    // The previously satisfied criterion remains passed (ratchet invariant)
    expect(contract?.criteria.find((c) => c.check === "lint clean")?.passed).toBe(true);
    expect(contract?.criteria.find((c) => c.check === "deploy verified")?.passed).toBe(false);
  } finally {
    clearContract(sessionId);
  }
}, 20_000);

test("satisfyCriterion handles case-insensitivity, normalization, and updating evidence", () => {
  const sessionId = randomUUID();
  try {
    declareContract(["Build Succeeded", "Docs Updated"], sessionId);

    // Fails on unknown check
    expect(satisfyCriterion("non-existent check", "artifact.md", sessionId)).toEqual({
      error: "no declared criterion matches: non-existent check",
    });

    // Fails on empty evidence
    expect(satisfyCriterion("Build Succeeded", "   ", sessionId)).toEqual({
      error: "evidence is required: specify what you did to complete this task (e.g., files modified, test output, or artifact produced)",
    });

    // Satisfies with case-insensitive check
    const res = satisfyCriterion("build succeeded", "exit 0 from npm run build", sessionId);
    expect(res.remaining).toEqual(["Docs Updated"]);

    let contract = readContract(sessionId);
    const buildCrit = contract?.criteria.find((c) => c.check === "Build Succeeded");
    expect(buildCrit?.passed).toBe(true);
    expect(buildCrit?.evidence).toBe("exit 0 from npm run build");

    // Updating evidence for an existing satisfied criterion
    satisfyCriterion("docs updated", "Updated README.md section on usage with configuration parameters", sessionId);
    contract = readContract(sessionId);
    expect(contract?.criteria.every((c) => c.passed)).toBe(true);
    expect(contractStopReason(true, sessionId)).toBe("");
  } finally {
    clearContract(sessionId);
  }
}, 20_000);

test("recordObservedRun closes executable criteria accurately without false positives", () => {
  const sessionId = randomUUID();
  try {
    declareContract(["bun test", "git status"], sessionId);

    // Substring in an echo/grep argument should NOT close the criterion
    recordObservedRun('echo "bun test output"', true, sessionId);
    let contract = readContract(sessionId);
    expect(contract?.criteria.find((c) => c.check === "bun test")?.passed).toBe(false);

    // Non-zero exit should mark failedFirst but NOT passed
    recordObservedRun("bun test", false, sessionId);
    contract = readContract(sessionId);
    expect(contract?.criteria.find((c) => c.check === "bun test")?.failedFirst).toBe(true);
    expect(contract?.criteria.find((c) => c.check === "bun test")?.passed).toBe(false);

    // Successful run closes the criterion
    recordObservedRun("cd repo; bun test --coverage", true, sessionId);
    contract = readContract(sessionId);
    expect(contract?.criteria.find((c) => c.check === "bun test")?.passed).toBe(true);

    // Case-insensitive command execution closes git status
    recordObservedRun("GIT STATUS --short", true, sessionId);
    contract = readContract(sessionId);
    expect(contract?.criteria.find((c) => c.check === "git status")?.passed).toBe(true);
  } finally {
    clearContract(sessionId);
  }
});

test("concurrent sessions have strictly isolated contracts", () => {
  const sessionA = `session-a-${randomUUID()}`;
  const sessionB = `session-b-${randomUUID()}`;
  const sessionC = `session-c-${randomUUID()}`;

  try {
    declareContract(["criterion for A"], sessionA);
    declareContract(["criterion for B1", "criterion for B2"], sessionB);

    expect(contractDeclared(sessionA)).toBe(true);
    expect(contractDeclared(sessionB)).toBe(true);
    expect(contractDeclared(sessionC)).toBe(false);

    // Satisfying session A does not satisfy session B
    satisfyCriterion("criterion for A", "evidence A", sessionA);
    expect(contractStopReason(true, sessionA)).toBe("");
    expect(contractStopReason(true, sessionB)).toContain("criterion for B1");

    // Clearing session A leaves session B untouched
    clearContract(sessionA);
    expect(contractDeclared(sessionA)).toBe(false);
    expect(contractDeclared(sessionB)).toBe(true);
    expect(readContract(sessionB)?.criteria.length).toBe(2);
  } finally {
    clearContract(sessionA);
    clearContract(sessionB);
    clearContract(sessionC);
  }
});

test("hook enforces hard-block when no contract is declared and allows execution after declaration", () => {
  const id = randomUUID();
  const dbPath = join(tmpdir(), `cairn-contract-hook-${id}.db`);
  const hook = join(import.meta.dir, "..", "src", "hosts", "copilot-cli", "hook.ts");
  const env = { ...process.env, CAIRN_DB_PATH: dbPath };
  const invoke = (mode: string, payload: object) =>
    spawnSync(process.execPath, [hook, mode], { input: JSON.stringify(payload), env });
  const session = `contract-enforce-${id}`;

  try {
    invoke("user-prompt", { sessionId: session, prompt: "Refactor the module." });

    // Read-only tools (view/grep/search) are allowed before contract declaration
    const readProbe = invoke("pre-tool", {
      sessionId: session,
      toolName: "view",
      toolArgs: { path: "src/index.ts" },
    });
    expect(readProbe.stdout.toString()).toBe("{}");

    // Mutation tool (edit/powershell write) is hard-blocked before contract declaration
    const writeProbe = invoke("pre-tool", {
      sessionId: session,
      toolName: "edit",
      toolArgs: { path: "src/index.ts", old_str: "a", new_str: "b" },
    });
    expect(writeProbe.stdout.toString()).toContain('"permissionDecision":"deny"');
    expect(writeProbe.stdout.toString()).toContain("Declare your plan first");

    // Declare contract via post-tool
    invoke("post-tool", {
      sessionId: session,
      toolName: "cairn-contract",
      toolArgs: { checks: ["src/index.ts updated", "bun test"] },
      toolResult: { accepted: true },
    });

    // Before editing, research and root node declaration in Cairn are required
    const writeWithoutResearch = invoke("pre-tool", {
      sessionId: session,
      toolName: "edit",
      toolArgs: { path: "src/index.ts", old_str: "a", new_str: "b" },
    });
    expect(writeWithoutResearch.stdout.toString()).toContain('"permissionDecision":"deny"');
    expect(writeWithoutResearch.stdout.toString()).toContain("Research in Cairn first");

    // Perform brain search
    invoke("post-tool", {
      sessionId: session,
      toolName: "cairn-brain_search",
      toolArgs: { query: "refactor" },
      toolResult: { success: true },
    });

    // Still blocked until root node is created
    const writeWithoutNode = invoke("pre-tool", {
      sessionId: session,
      toolName: "edit",
      toolArgs: { path: "src/index.ts", old_str: "a", new_str: "b" },
    });
    expect(writeWithoutNode.stdout.toString()).toContain('"permissionDecision":"deny"');
    expect(writeWithoutNode.stdout.toString()).toContain("Decompose your task in Cairn first");

    // Create and answer nodes
    invoke("post-tool", {
      sessionId: session,
      toolName: "cairn-brain_create",
      toolArgs: { text: "How to refactor?" },
      toolResult: { success: true, id: "root" },
    });
    invoke("post-tool", {
      sessionId: session,
      toolName: "cairn-brain_create",
      toolArgs: { text: "What is subtask 1?" },
      toolResult: { success: true, id: "child1" },
    });
    invoke("post-tool", {
      sessionId: session,
      toolName: "cairn-brain_create",
      toolArgs: { text: "What is subtask 2?" },
      toolResult: { success: true, id: "child2" },
    });
    invoke("post-tool", {
      sessionId: session,
      toolName: "cairn-brain_mutate",
      toolArgs: { id: "child1", answer: "Done 1", citation: "https://example.com" },
      toolResult: { success: true, id: "child1" },
    });
    invoke("post-tool", {
      sessionId: session,
      toolName: "cairn-brain_mutate",
      toolArgs: { id: "child2", answer: "Done 2", citation: "https://example.com" },
      toolResult: { success: true, id: "child2" },
    });
    invoke("post-tool", {
      sessionId: session,
      toolName: "cairn-brain_mutate",
      toolArgs: { id: "root", answer: "Done", citation: "https://example.com" },
      toolResult: { success: true, id: "root" },
    });

    // Mutation tool is now permitted
    const writeAllowed = invoke("pre-tool", {
      sessionId: session,
      toolName: "edit",
      toolArgs: { path: "src/index.ts", old_str: "a", new_str: "b" },
    });
    expect(writeAllowed.stdout.toString()).toBe("{}");

    // Execute the edit tool
    invoke("post-tool", {
      sessionId: session,
      toolName: "edit",
      toolArgs: { path: "src/index.ts", old_str: "a", new_str: "b" },
      toolResult: { success: true },
    });

    // Turn completion is blocked because contract criteria are still unmet
    const stopBlocked = invoke("agent-stop", { sessionId: session });
    expect(stopBlocked.stdout.toString()).toContain('"decision":"block"');
    expect(stopBlocked.stdout.toString()).toContain("These declared plan items are unmet");

    // Close one criterion via command run, and one via explicit evidence in single call
    invoke("post-tool", {
      sessionId: session,
      toolName: "powershell",
      toolArgs: { command: "bun test" },
      toolResult: { success: true, textResultForLlm: "exit code 0" },
    });
    invoke("post-tool", {
      sessionId: session,
      toolName: "cairn-contract",
      toolArgs: { satisfied: "src/index.ts updated", evidence: "refactored exports" },
      toolResult: { accepted: true },
    });

    // All criteria met -> agent-stop releases turn
    const stopReleased = invoke("agent-stop", { sessionId: session });
    expect(stopReleased.stdout.toString()).toBe("{}");
  } finally {
    clearContract(session);
    rmSync(dbPath, { force: true });
  }
});

test("contract tool handles simultaneous append and satisfy in a single call", () => {
  const id = randomUUID();
  const dbPath = join(tmpdir(), `cairn-contract-simultaneous-${id}.db`);
  const hook = join(import.meta.dir, "..", "src", "hosts", "copilot-cli", "hook.ts");
  const env = { ...process.env, CAIRN_DB_PATH: dbPath };
  const invoke = (mode: string, payload: object) =>
    spawnSync(process.execPath, [hook, mode], { input: JSON.stringify(payload), env });
  const session = `simultaneous-${id}`;

  try {
    invoke("user-prompt", { sessionId: session, prompt: "Build and deploy." });

    // Initial declaration of criterion 1
    invoke("post-tool", {
      sessionId: session,
      toolName: "cairn-contract",
      toolArgs: { checks: ["build pass"] },
      toolResult: { accepted: true },
    });

    // Appending criterion 2 AND satisfying criterion 1 in the same call
    const simultaneous = invoke("post-tool", {
      sessionId: session,
      toolName: "cairn-contract",
      toolArgs: {
        checks: ["deploy pass"],
        satisfied: "build pass",
        evidence: "binary compiled",
      },
      toolResult: { accepted: true },
    });
    expect(simultaneous.status).toBe(0);

    const contract = readContract(session);
    expect(contract?.criteria.length).toBe(2);
    expect(contract?.criteria.find((c) => c.check === "build pass")?.passed).toBe(true);
    expect(contract?.criteria.find((c) => c.check === "deploy pass")?.passed).toBe(false);
  } finally {
    clearContract(session);
    rmSync(dbPath, { force: true });
  }
});

test("plan tool provides interactive todo checklist workflow and formatted summaries", () => {
  const id = randomUUID();
  const dbPath = join(tmpdir(), `cairn-plan-tool-${id}.db`);
  const hook = join(import.meta.dir, "..", "src", "hosts", "copilot-cli", "hook.ts");
  const env = { ...process.env, CAIRN_DB_PATH: dbPath };
  const invoke = (mode: string, payload: object) =>
    spawnSync(process.execPath, [hook, mode], { input: JSON.stringify(payload), env });
  const session = `plan-workflow-${id}`;

  try {
    invoke("user-prompt", { sessionId: session, prompt: "Create a feature." });

    // Initial plan declaration using 'tasks'
    const planDeclared = invoke("post-tool", {
      sessionId: session,
      toolName: "cairn-plan",
      toolArgs: { tasks: ["Write tests", "Implement logic", "Verify build"] },
      toolResult: { accepted: true },
    });
    expect(planDeclared.status).toBe(0);
    const planSummary = planDeclared.stdout.toString();
    expect(planSummary).toContain("Plan state:");
    expect(planSummary).toContain("- [ ] Write tests");
    expect(planSummary).toContain("- [ ] Implement logic");
    expect(planSummary).toContain("- [ ] Verify build");

    // Complete item 1 with evidence
    const item1Done = invoke("post-tool", {
      sessionId: session,
      toolName: "cairn-plan",
      toolArgs: { completed: "Write tests", evidence: "tests/feature.test.ts created" },
      toolResult: { accepted: true },
    });
    expect(item1Done.stdout.toString()).toContain("- [x] Write tests (Evidence: tests/feature.test.ts created)");
    expect(item1Done.stdout.toString()).toContain("- [ ] Implement logic");

    // Append a newly discovered task while completing item 2
    const item2Done = invoke("post-tool", {
      sessionId: session,
      toolName: "cairn-plan",
      toolArgs: {
        tasks: ["Update documentation"],
        completed: "Implement logic",
        evidence: "src/feature.ts implemented",
      },
      toolResult: { accepted: true },
    });
    expect(item2Done.stdout.toString()).toContain("- [x] Implement logic");
    expect(item2Done.stdout.toString()).toContain("- [ ] Update documentation");

    // Close remaining items
    invoke("post-tool", {
      sessionId: session,
      toolName: "cairn-plan",
      toolArgs: { completed: "Verify build", evidence: "bun test passed" },
      toolResult: { accepted: true },
    });
    invoke("post-tool", {
      sessionId: session,
      toolName: "cairn-plan",
      toolArgs: { completed: "Update documentation", evidence: "docs updated" },
      toolResult: { accepted: true },
    });

    const contract = readContract(session);
    expect(contract?.criteria.every((c) => c.passed)).toBe(true);
  } finally {
    clearContract(session);
    rmSync(dbPath, { force: true });
  }
});

test("declared plan enforces full completion even when executionToolCount is 0", () => {
  const sessionId = randomUUID();
  try {
    declareContract(["Implement stereo rendering", "Implement IK hands"], sessionId);

    // With executionToolCount === 0 (changedDurableState: false), contractStopReason MUST STILL block on unmet declared tasks
    expect(contractStopReason(false, sessionId)).toContain("Not done. These declared plan items are unmet: Implement stereo rendering | Implement IK hands");

    // Satisfy one item
    satisfyCriterion("Implement stereo rendering", "src/stereo.cpp implemented", sessionId);
    expect(contractStopReason(false, sessionId)).toContain("Implement IK hands");
    expect(contractStopReason(false, sessionId)).not.toContain("Implement stereo rendering");

    // Satisfy the second item
    satisfyCriterion("Implement IK hands", "src/ik.cpp implemented", sessionId);
    expect(contractStopReason(false, sessionId)).toBe("");
  } finally {
    clearContract(sessionId);
  }
});

test("satisfyCriterion validates evidence quality and rejects trivial/vacuous proof", () => {
  const sessionId = randomUUID();
  try {
    declareContract(["Feature Implemented"], sessionId);
    expect(satisfyCriterion("Feature Implemented", "done", sessionId)).toEqual({
      error: "insufficient evidence: specify what you did to complete this task with concrete details (e.g., files modified, command output, or artifact produced)",
    });
    expect(satisfyCriterion("Feature Implemented", "ok", sessionId)).toEqual({
      error: "insufficient evidence: specify what you did to complete this task with concrete details (e.g., files modified, command output, or artifact produced)",
    });
    expect(satisfyCriterion("Feature Implemented", "fixed", sessionId)).toEqual({
      error: "insufficient evidence: specify what you did to complete this task with concrete details (e.g., files modified, command output, or artifact produced)",
    });
    expect(satisfyCriterion("Feature Implemented", "implemented user authentication in src/auth.ts", sessionId)).toEqual({
      remaining: [],
    });
  } finally {
    clearContract(sessionId);
  }
});

test("declared plan is NEVER released when items are unmet regardless of nudge count", () => {
  const sessionId = randomUUID();
  try {
    declareContract(["Deploy Service"], sessionId);
    for (let i = 0; i < 10; i++) {
      noteContractNudge(sessionId);
      expect(contractStopReason(true, sessionId)).toContain("These declared plan items are unmet");
      expect(contractExhausted(sessionId)).toBe(false);
    }
  } finally {
    clearContract(sessionId);
  }
});

test("plan completion invokes live 3.7 reviewer to verify evidence and rejects mock/lame proof", () => {
  const sessionId = randomUUID();
  delete process.env.CAIRN_REVIEWER_MOCK;
  try {
    declareContract(["Export video footage evidence"], sessionId);

    // Attempting to complete with a text log should be rejected by the reviewer
    const res = satisfyCriterion(
      "Export video footage evidence",
      "Generated OutlastVR_FootageVerification.log documenting 150 frames of camera movement",
      sessionId,
    );
    expect(res.error).toBeDefined();
    expect(res.error).toContain("reviewer rejected completion");
  } finally {
    process.env.CAIRN_REVIEWER_MOCK = "approve";
    clearContract(sessionId);
  }
}, 30_000);

test("live 3.7 reviewer catches inadequate research and incomplete edge case testing", () => {
  const sessionId = randomUUID();
  delete process.env.CAIRN_REVIEWER_MOCK;
  try {
    declareContract([
      "Research vector indexing algorithm",
      "Test vector encoding and decoding against boundary edge cases",
    ], sessionId);

    // 1. Inadequate research: vague claim with no files, symbols, or citations
    const vagueResearch = satisfyCriterion(
      "Research vector indexing algorithm",
      "Looked around the codebase and understood how vectors work in general.",
      sessionId,
    );
    expect(vagueResearch.error).toBeDefined();
    expect(vagueResearch.error).toContain("reviewer rejected completion");

    // 2. Concrete research with file citations and findings is approved
    const solidResearch = satisfyCriterion(
      "Research vector indexing algorithm",
      "Audited src/core/vector-index.ts and src/core/embed.ts: identified cosine loop unrolling and sqlite-vec handle reuse across exactVectorCandidates.",
      sessionId,
    );
    expect(solidResearch.error).toBeUndefined();

    // 3. Incomplete testing: blanket assertion with no edge case execution
    const incompleteTest = satisfyCriterion(
      "Test vector encoding and decoding against boundary edge cases",
      "Checked the code mentally and everything looks good for edge cases.",
      sessionId,
    );
    expect(incompleteTest.error).toBeDefined();
    expect(incompleteTest.error).toContain("reviewer rejected completion");

    // 4. Concrete test verification covering real test files and outputs
    const robustTest = satisfyCriterion(
      "Test vector encoding and decoding against boundary edge cases",
      "Executed `bun test tests/vector.test.ts` (exit 0): 7 tests passed covering float32 precision, IEEE-754 little-endian byte layout, buffer offsets, and null/unreadable edge cases in tests/vector.test.ts.",
      sessionId,
    );
    expect(robustTest.error).toBeUndefined();
    expect(robustTest.remaining).toEqual([]);
  } finally {
    process.env.CAIRN_REVIEWER_MOCK = "approve";
    clearContract(sessionId);
  }
}, 90_000);

test("live 3.7 reviewer inspects codebase files on disk and rejects non-existent code claims", () => {
  const sessionId = randomUUID();
  delete process.env.CAIRN_REVIEWER_MOCK;
  try {
    declareContract([
      "Implement vector serialization utility",
    ], sessionId);

    // 1. Claiming a non-existent file: reviewer actively inspects the repo, detects absence, and rejects
    const fakeFile = satisfyCriterion(
      "Implement vector serialization utility",
      "Implemented MemoryScanner class and scanning methods in src/fake_scanner_nonexistent_xyz.h",
      sessionId,
    );
    expect(fakeFile.error).toBeDefined();
    expect(fakeFile.error).toContain("reviewer rejected completion");

    // 2. Claiming real file that exists in repo: reviewer reads the code and approves
    const realFile = satisfyCriterion(
      "Implement vector serialization utility",
      "Implemented encodeVector with Float32Array conversion in src/core/vector.ts",
      sessionId,
    );
    expect(realFile.error).toBeUndefined();
  } finally {
    process.env.CAIRN_REVIEWER_MOCK = "approve";
    clearContract(sessionId);
  }
}, 60_000);


