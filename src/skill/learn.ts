import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

// The async learn trigger. After a turn finishes, the WHOLE skill-forming process (extract the run ->
// learn: label + grade + master, with the raw transcript as context -> categorize -> store) runs in a
// DETACHED background process so it outlives the short Stop hook and never blocks the user.
//
// Loop guard (critical): the learner must never kick off its own skill-forming, or it would recurse
// forever. Two layers stop it: the spawned worker runs `claude -p --setting-sources project` so cairn's
// hooks do not fire inside it, AND CAIRN_SKILL_WORKER=1 is set on the worker so any nested trigger no-ops.

export function isSkillWorker(): boolean {
  return process.env.CAIRN_SKILL_WORKER === "1";
}

const WORKER = () => process.env.CAIRN_SKILL_WORKER_PATH || fileURLToPath(new URL("../../scripts/skill-learn-worker.ts", import.meta.url));

// Fire-and-forget the learner over a turn's transcript, detached. No-op (false) inside a worker (loop
// guard), with no transcript, or on spawn failure. Never throws.
export function learnFromTranscript(transcriptPath: string): boolean {
  if (isSkillWorker() || !transcriptPath) return false;
  // The run records its progress to the activity log; watch it live in the web UI at /activity (cairn ui).
  // No terminal is spawned (that was unreliable across Windows default-terminal setups).
  try {
    const child = spawn(process.platform === "win32" ? "bun.exe" : "bun", [WORKER(), transcriptPath], {
      detached: true,
      stdio: "ignore",
      windowsHide: true, // no console window pops up on Windows (the detached worker is invisible)
      // CAIRN_SKILL_WORKER blocks recursion; CAIRN_READONLY is cleared because the worker WRITES skills
      // (the hook that spawns it runs read-only).
      env: { ...process.env, CAIRN_SKILL_WORKER: "1", CAIRN_READONLY: "" },
    });
    child.unref(); // let the parent (the Stop hook) exit immediately
    return true;
  } catch { return false; }
}
