// Regression tests for the "Queued (N)" pile-up: a declared plan whose items the turn could not close
// blocked the stop hook on every single attempt, forever. Both defects that produced it are covered here.
import { test, expect, beforeEach, afterEach } from "bun:test";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { config } from "../src/core/config";
import {
  clearContract,
  contractStopReason,
  declareContract,
  noteContractNudge,
  readContract,
  satisfyCriterion,
} from "../src/hosts/copilot-cli/contract";

const globalLedger = join(dirname(process.env.CAIRN_DB_PATH || config.dbPath), "contract.json");

beforeEach(() => {
  process.env.CAIRN_REVIEWER_MOCK = "approve";
});
afterEach(() => {
  delete process.env.CAIRN_REVIEWER_MOCK;
});

test("an unmet plan nags hard but is bounded, so the stop gate can never queue forever", () => {
  const sessionId = randomUUID();
  try {
    declareContract(["Ship the thing", "Verify the thing"], sessionId);

    // It must genuinely insist: the first attempts are all blocked while an item is open.
    const cap = Number(process.env.CAIRN_PLAN_CAP || "6");
    for (let attempt = 0; attempt < cap; attempt++) {
      const reason = contractStopReason(true, sessionId);
      expect(reason).toContain("Ship the thing");
      expect(reason).toContain("Verify the thing");
      noteContractNudge(sessionId);
    }

    // ...but the demand expires instead of repeating without end.
    noteContractNudge(sessionId);
    expect(readContract(sessionId)!.nudges).toBeGreaterThan(cap);
    expect(contractStopReason(true, sessionId)).toBe("");

    // The plan is released, not silently marked done: the items are still visibly open.
    expect(readContract(sessionId)!.criteria.every((c) => !c.passed)).toBe(true);
  } finally {
    clearContract(sessionId);
  }
});

test("closing every item releases the gate immediately, well before the cap", () => {
  const sessionId = randomUUID();
  try {
    declareContract(["Ship the thing", "Verify the thing"], sessionId);
    expect(contractStopReason(true, sessionId)).not.toBe("");

    expect(satisfyCriterion("Ship the thing", "Wrote src/thing.ts", sessionId).error).toBeUndefined();
    expect(contractStopReason(true, sessionId)).toContain("Verify the thing");

    expect(satisfyCriterion("Verify the thing", "bun test passed", sessionId).error).toBeUndefined();
    expect(contractStopReason(true, sessionId)).toBe("");
  } finally {
    clearContract(sessionId);
  }
});

test("a nudged-out plan does not leak its release into a different session", () => {
  const exhausted = randomUUID();
  const fresh = randomUUID();
  try {
    declareContract(["Only item"], exhausted);
    for (let i = 0; i <= Number(process.env.CAIRN_PLAN_CAP || "6"); i++) noteContractNudge(exhausted);
    expect(contractStopReason(true, exhausted)).toBe("");

    declareContract(["Only item"], fresh);
    expect(contractStopReason(true, fresh)).toContain("Only item");
  } finally {
    clearContract(exhausted);
    clearContract(fresh);
  }
});

// The second defect: the MCP server process is never told which session a call belongs to, so any ledger
// write it performed landed in one global file shared by every session on the machine. That file grew
// without bound, fuzzy-matched a "completed" item against another session's leftovers, and reported
// failure for items the host hook had in fact recorded — leaving the real item unmet forever.
test("the plan tool acknowledges without writing any ledger, so no global file is ever created", async () => {
  const before = existsSync(globalLedger);

  const responses = await callPlanTool([
    { tasks: ["Task from an MCP client with no session id"] },
    { completed: "Task from an MCP client with no session id", evidence: "did the work" },
  ]);

  expect(responses).toHaveLength(2);
  expect(responses[0]).toMatchObject({ accepted: true });
  expect(responses[1]).toMatchObject({ accepted: true, completed: "Task from an MCP client with no session id" });

  // The decisive assertion: acknowledging a plan must never touch a machine-wide ledger.
  expect(existsSync(globalLedger)).toBe(before);
}, 60_000);

test("the plan tool still refuses to close an item with no evidence", async () => {
  const [res] = await callPlanTool([{ completed: "Some item", evidence: "   " }]);
  expect(String(res.error ?? "")).toContain("evidence is required");
}, 60_000);

/** Drive the real MCP server over stdio the way a host client does. */
async function callPlanTool(calls: Record<string, unknown>[]): Promise<Record<string, unknown>[]> {
  return new Promise((resolve, reject) => {
    const proc = spawn("bun", ["run", "src/mcp/server.ts"], {
      cwd: join(import.meta.dir, ".."),
      stdio: ["pipe", "pipe", "pipe"],
      shell: process.platform === "win32",
      env: { ...process.env, CAIRN_SKIP_HOOKS: "1" },
    });

    let buffer = "";
    const results: Record<string, unknown>[] = [];
    const done = (fn: () => void) => { clearTimeout(timer); try { proc.kill(); } catch { /* ignore */ } fn(); };
    const timer = setTimeout(() => done(() => reject(new Error("MCP server timed out"))), 45_000);

    proc.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        let message: { id?: number; result?: { content?: { text?: string }[]; isError?: boolean } };
        try { message = JSON.parse(line); } catch { continue; }
        if (message.id === 1) {
          proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
          calls.forEach((args, index) => {
            proc.stdin.write(`${JSON.stringify({
              jsonrpc: "2.0", id: index + 2, method: "tools/call",
              params: { name: "plan", arguments: args },
            })}\n`);
          });
          continue;
        }
        if (typeof message.id === "number" && message.id >= 2) {
          const text = message.result?.content?.[0]?.text ?? "";
          let parsed: Record<string, unknown>;
          try { parsed = JSON.parse(text) as Record<string, unknown>; } catch { parsed = { error: text }; }
          if (message.result?.isError) parsed = { error: text };
          results.push(parsed);
          if (results.length === calls.length) done(() => resolve(results));
        }
      }
    });

    proc.on("error", (err) => done(() => reject(err)));
    proc.stdin.write(`${JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "1" } },
    })}\n`);
  });
}

// The production loop the per-contract counter could not catch. hasActiveContract() treats a nudged
// contract as "not a live declaration", so the user-prompt hook calls clearContract() at every turn
// boundary. The counter stored on the contract therefore reset to 0 every turn and never reached the cap:
// the gate re-armed forever and blocked once per turn for the life of the session. Observed in the wild as
// a session with 33 contract_blocked telemetry events whose ledger on disk still read "nudges": 0.
test("the gate expires across turn boundaries even though each prompt wipes the contract", () => {
  const sessionId = randomUUID();
  try {
    const cap = Number(process.env.CAIRN_PLAN_CAP || "6");
    const items = ["Close the unclosable item"];

    for (let turn = 0; turn <= cap; turn++) {
      // A new turn: the prompt hook wipes the contract, and the turn re-declares the same open item.
      clearContract(sessionId);
      declareContract(items, sessionId);
      expect(readContract(sessionId)!.nudges).toBe(0); // the wipe really did reset the per-contract counter
      expect(contractStopReason(true, sessionId)).toContain("Close the unclosable item");
      noteContractNudge(sessionId);
    }

    // One more turn boundary, and the demand must now be expired rather than re-armed.
    clearContract(sessionId);
    declareContract(items, sessionId);
    expect(readContract(sessionId)!.nudges).toBe(0);
    expect(contractStopReason(true, sessionId)).toBe("");
    expect(readContract(sessionId)!.criteria.every((c) => !c.passed)).toBe(true);
  } finally {
    clearContract(sessionId);
  }
});

// The cap must bound UNPRODUCTIVE nagging only. A session that keeps closing items keeps its gate.
test("closing an item re-arms the cross-turn budget", () => {
  const sessionId = randomUUID();
  try {
    const cap = Number(process.env.CAIRN_PLAN_CAP || "6");
    declareContract(["First item", "Second item"], sessionId);
    for (let turn = 0; turn < cap; turn++) noteContractNudge(sessionId);

    // Real progress resets the budget, so the remaining item is still enforced.
    expect(satisfyCriterion("First item", "Implemented first item in src/first.ts", sessionId).error)
      .toBeUndefined();
    clearContract(sessionId);
    declareContract(["Second item"], sessionId);
    expect(contractStopReason(true, sessionId)).toContain("Second item");
  } finally {
    clearContract(sessionId);
  }
});
