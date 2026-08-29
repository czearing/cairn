// End-to-end proof that the plan stop gate cannot pile up in the host queue.
//
// Every previous fix here was made at the unit level and every one of them was defeated by a DIFFERENT
// mechanism that wiped the counter at a turn boundary: first the counter lived only on the contract, which
// clearContract() deletes at every prompt; then the cross-turn ledger was deleted wholesale by
// clearInstrumentDoubt() on every stop. Unit tests on contractStopReason passed the whole time. So this
// test drives the real hook process across real turn boundaries and asserts the observable behaviour the
// user actually reports: the gate must stop injecting "these plan items are unmet" forever.
import { test, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";

const HOOK = join(import.meta.dir, "..", "src", "hosts", "copilot-cli", "hook.ts");

function turnDriver() {
  const id = randomUUID();
  const env = {
    ...process.env,
    CAIRN_DB_PATH: join(tmpdir(), `cairn-queue-${id}.db`),
    COPILOT_HOME: join(tmpdir(), `cairn-queue-home-${id}`),
    CAIRN_MAX_LEARNERS: "0",
    CAIRN_REVIEWER_MOCK: "approve",
  };
  const invoke = (mode: string, payload: object) => {
    const out = spawnSync(process.execPath, [HOOK, mode], { input: JSON.stringify(payload), env });
    const stdout = out.stdout.toString().trim();
    try {
      return JSON.parse(stdout) as { decision?: string; reason?: string };
    } catch {
      return {};
    }
  };
  return { sessionId: id, invoke };
}

test("the plan gate stops nagging across real turns instead of queueing forever", () => {
  const { sessionId, invoke } = turnDriver();
  const unclosable = "Close an item this turn can never close";
  const blockedTurns: number[] = [];
  const TURNS = 25;

  for (let turn = 0; turn < TURNS; turn++) {
    invoke("user-prompt", { sessionId, prompt: `Turn ${turn}: keep working on the thing.` });

    // The turn declares its plan, exactly as the `plan` tool's post-tool event does...
    invoke("post-tool", {
      sessionId,
      toolName: "plan",
      toolArgs: { tasks: [unclosable] },
      toolResult: { accepted: true },
    });

    // ...satisfies the brain workflow, so the workflow gate cannot mask the plan gate under test...
    const post = (toolName: string, toolArgs: object, toolResult: object = { success: true }) =>
      invoke("post-tool", { sessionId, toolName, toolArgs, toolResult });
    post("cairn-brain_search", { query: "the thing" });
    for (const nodeId of ["root", "child-1", "child-2"]) post("cairn-brain_create", { text: nodeId }, { id: nodeId });
    post("cairn-brain_mutate", { id: "child-1", answer: "evidence one" });
    post("cairn-brain_mutate", { id: "child-2", answer: "evidence two" });
    post("cairn-brain_mutate", { id: "root", answer: "integrated synthesis" });

    // ...and does real work, so the gate considers the turn to have acted.
    post("str_replace_editor", { command: "create", path: "src/thing.ts" });

    let stop = invoke("agent-stop", { sessionId });
    // The completion reminder fires once per turn ahead of the plan gate; step past it.
    if (stop.decision === "block" && !(stop.reason ?? "").includes(unclosable)) {
      stop = invoke("agent-stop", { sessionId });
    }
    if (stop.decision === "block" && (stop.reason ?? "").includes(unclosable)) blockedTurns.push(turn);
  }

  // It must genuinely nag: a gate that never blocks is not a gate.
  expect(blockedTurns.length).toBeGreaterThan(0);

  // ...but it must give up. This is the whole point: the user's session recorded 53 consecutive blocked
  // turns before this was fixed, so any late block here is the bug reproducing.
  const cap = Number(process.env.CAIRN_PLAN_CAP || "6");
  expect(blockedTurns.length).toBeLessThanOrEqual(cap + 2);
  expect(Math.max(...blockedTurns)).toBeLessThan(cap + 3);

  // The final turns must be released outright.
  const tail = invoke("agent-stop", { sessionId });
  expect(tail.decision === "block" && (tail.reason ?? "").includes(unclosable)).toBe(false);
}, 240_000);
