import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import {
  clearContract,
  contractDeclared,
  hasActiveContract,
  readContract,
  declareContract,
  satisfyCriterion,
} from "../src/hosts/copilot-cli/contract";

beforeAll(() => {
  process.env.CAIRN_REVIEWER_MOCK = "approve";
});

afterAll(() => {
  delete process.env.CAIRN_REVIEWER_MOCK;
});

test("mid-turn user message does not wipe declared contract or reset pre-requisite hooks", () => {
  const sessionId = `midturn-${randomUUID()}`;
  const dbPath = join(tmpdir(), `cairn-midturn-${sessionId}.db`);
  const hook = join(import.meta.dir, "..", "src", "hosts", "copilot-cli", "hook.ts");
  const env = { ...process.env, CAIRN_DB_PATH: dbPath, CAIRN_MAX_LEARNERS: "0" };

  const invoke = (mode: string, payload: object) =>
    spawnSync(process.execPath, [hook, mode], {
      input: JSON.stringify(payload),
      env,
    });

  try {
    // 1. User sends initial prompt
    const turn1 = invoke("user-prompt", { sessionId, prompt: "Build the auth module" });
    expect(turn1.status).toBe(0);

    // 2. Agent searches brain
    invoke("post-tool", {
      sessionId,
      toolName: "cairn-brain_search",
      toolArgs: { query: "auth module design" },
      toolResult: { success: true, textResultForLlm: "[]" },
    });

    // 3. Agent creates decomposition root node
    invoke("post-tool", {
      sessionId,
      toolName: "cairn-brain_create",
      toolArgs: { text: "How to build auth module?" },
      toolResult: { success: true, id: "root-node-auth" },
    });

    // 4. Agent declares contract plan
    declareContract(["Create src/auth.ts", "Run unit tests"], sessionId);
    expect(contractDeclared(sessionId)).toBe(true);
    expect(hasActiveContract(sessionId)).toBe(true);

    // 5. Pre-tool check on file mutation tool (edit) is allowed
    const preEdit1 = invoke("pre-tool", {
      sessionId,
      toolName: "edit",
      toolArgs: { path: "src/auth.ts", old_str: "a", new_str: "b" },
    });
    expect(preEdit1.stdout.toString()).toBe("{}");

    // 6. User sends a mid-turn message before contract is finished
    const midTurnMsg = invoke("user-prompt", {
      sessionId,
      prompt: "Make sure tokens expire in 24 hours",
    });
    expect(midTurnMsg.status).toBe(0);

    // 7. Verify contract is NOT reset/wiped
    expect(contractDeclared(sessionId)).toBe(true);
    expect(hasActiveContract(sessionId)).toBe(true);
    const activeContract = readContract(sessionId);
    expect(activeContract).not.toBeNull();
    expect(activeContract?.criteria.length).toBe(2);
    expect(activeContract?.criteria[0].check).toBe("Create src/auth.ts");
    expect(activeContract?.criteria[1].check).toBe("Run unit tests");

    // 8. Pre-requisite hooks MUST NOT reset: edit tool is still allowed without being denied
    const preEdit2 = invoke("pre-tool", {
      sessionId,
      toolName: "edit",
      toolArgs: { path: "src/auth.ts", old_str: "b", new_str: "c" },
    });
    expect(preEdit2.stdout.toString()).toBe("{}");

    // 9. Mutate root node, execute tools, and satisfy criteria
    invoke("post-tool", {
      sessionId,
      toolName: "cairn-brain_mutate",
      toolArgs: { id: "root-node-auth", answer: "Auth implemented", citation: "https://auth0.com" },
      toolResult: { success: true },
    });
    satisfyCriterion("Create src/auth.ts", "created src/auth.ts with 24h JWT expiration", sessionId);
    satisfyCriterion("Run unit tests", "bun test passed with 100% assertions", sessionId);

    // 10. Contract is now completely satisfied
    expect(hasActiveContract(sessionId)).toBe(false);

    // 11. Agent-stop releases cleanly
    const stopResult = invoke("agent-stop", { sessionId });
    expect(stopResult.stdout.toString()).toBe("{}");

    // 12. Subsequent turn after full completion resets contract cleanly
    const nextTurn = invoke("user-prompt", { sessionId, prompt: "Now write the docs" });
    expect(nextTurn.status).toBe(0);
    expect(contractDeclared(sessionId)).toBe(false);
  } finally {
    clearContract(sessionId);
    rmSync(dbPath, { force: true });
  }
});
