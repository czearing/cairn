import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import type { RunInput } from "./pipeline";

// The async learn trigger. After a turn finishes, the WHOLE skill-forming process (label -> categorize ->
// compact -> review -> store -> assemble) runs in a DETACHED background process so it outlives the short
// Stop hook and never blocks the user.
//
// Loop guard (critical): the reviewer/compactor must never kick off their own skill-forming, or it would
// recurse forever. Two layers stop it: the spawned workers run `claude -p --setting-sources project` so
// cairn's hooks do not fire inside them, AND CAIRN_SKILL_WORKER=1 is set on the worker so any nested
// learnInBackground is a hard no-op.

export function isSkillWorker(): boolean {
  return process.env.CAIRN_SKILL_WORKER === "1";
}

const WORKER = () => process.env.CAIRN_SKILL_WORKER_PATH || fileURLToPath(new URL("../../scripts/skill-learn-worker.ts", import.meta.url));

// Fire-and-forget the learner in a detached process. Returns false (no-op) if we are already inside a
// worker (the loop guard) or the spawn fails. Never throws.
export function learnInBackground(input: RunInput, now: number): boolean {
  if (isSkillWorker()) return false; // a worker never spawns another learn
  const payload = join(tmpdir(), `cairn-learn-${now}.json`);
  try {
    writeFileSync(payload, JSON.stringify({ input, now }));
    const child = spawn(process.platform === "win32" ? "bun.exe" : "bun", [WORKER(), payload], {
      detached: true,
      stdio: "ignore",
      env: { ...process.env, CAIRN_SKILL_WORKER: "1" },
    });
    child.unref(); // let the parent (the Stop hook) exit immediately
    return true;
  } catch { return false; }
}
