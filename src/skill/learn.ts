import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

// The async learn trigger. After a turn finishes, the WHOLE skill-forming process (extract the run ->
// label -> categorize -> compact -> review -> store -> assemble) runs in a DETACHED background process so
// it outlives the short Stop hook and never blocks the user.
//
// Loop guard (critical): the reviewer/compactor must never kick off their own skill-forming, or it would
// recurse forever. Two layers stop it: the spawned workers run `claude -p --setting-sources project` so
// cairn's hooks do not fire inside them, AND CAIRN_SKILL_WORKER=1 is set on the worker so any nested
// trigger is a hard no-op.

export function isSkillWorker(): boolean {
  return process.env.CAIRN_SKILL_WORKER === "1";
}

const WORKER = () => process.env.CAIRN_SKILL_WORKER_PATH || fileURLToPath(new URL("../../scripts/skill-learn-worker.ts", import.meta.url));

// Fire-and-forget the learner over a turn's transcript, detached. No-op (false) inside a worker (loop
// guard), with no transcript, or on spawn failure. Never throws.
export function learnFromTranscript(transcriptPath: string): boolean {
  if (isSkillWorker() || !transcriptPath) return false;
  try {
    const child = spawn(process.platform === "win32" ? "bun.exe" : "bun", [WORKER(), transcriptPath], {
      detached: true,
      stdio: "ignore",
      // CAIRN_SKILL_WORKER blocks recursion; CAIRN_READONLY is cleared because the worker WRITES skills
      // (the hook that spawns it runs read-only).
      env: { ...process.env, CAIRN_SKILL_WORKER: "1", CAIRN_READONLY: "" },
    });
    child.unref(); // let the parent (the Stop hook) exit immediately
    return true;
  } catch { return false; }
}
