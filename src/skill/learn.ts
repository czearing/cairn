import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync, readdirSync, statSync, writeFileSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";

// The async learn trigger. After a turn finishes, the WHOLE skill-forming process (extract the run ->
// learn: label + grade + master, with the raw transcript as context -> categorize -> store) runs in a
// DETACHED background process so it outlives the short Stop hook and never blocks the user.
//
// Loop guard (critical): the learner must never kick off its own skill-forming, or it would recurse
// forever. Two layers stop it: the spawned worker runs `claude -p --setting-sources project` so cairn's
// hooks do not fire inside it, AND CAIRN_SKILL_WORKER=1 is set on the worker so any nested trigger no-ops.
//
// Concurrency cap: each learner run spends real `claude -p` time (classify + grade). When many fire at once
// (a burst of turns plus subagent stops) they saturate the CLI and time out (measured: ~12 concurrent
// claude.exe failed). So we cap how many learners run at once via lock files; over the cap, this turn's learn
// is skipped (a later turn re-learns the skill) rather than piling on and timing out.

export function isSkillWorker(): boolean {
  return process.env.CAIRN_SKILL_WORKER === "1";
}

const WORKER = () => process.env.CAIRN_SKILL_WORKER_PATH || fileURLToPath(new URL("../../scripts/skill-learn-worker.ts", import.meta.url));

const LEARNERS_DIR = () => process.env.CAIRN_LEARNERS_DIR || join(homedir(), ".cairn", "learners");
const MAX_LEARNERS = () => Number(process.env.CAIRN_MAX_LEARNERS || "4"); // concurrent claude -p learners allowed (read at call time)
const STALE_MS = 6 * 60 * 1000; // a lock older than this is a crashed worker; ignore it so the cap can't wedge

/** How many learner workers are currently running (lock files touched within STALE_MS). */
function activeLearners(): number {
  try {
    const now = Date.now();
    return readdirSync(LEARNERS_DIR()).filter((f) => {
      try { return now - statSync(join(LEARNERS_DIR(), f)).mtimeMs < STALE_MS; } catch { return false; }
    }).length;
  } catch { return 0; }
}

// Fire-and-forget the learner over a turn's transcript for the agent-DECLARED skill `label`, detached. No-op
// (false) inside a worker (loop guard), with no transcript or label, or when the concurrency cap is reached.
// Never throws. The label rides to the worker as env; the lock file is created here (so the count is
// accurate immediately) and removed by the worker on exit.
export function learnFromTranscript(transcriptPath: string, label: string): boolean {
  if (isSkillWorker() || !transcriptPath || !label.trim()) return false;
  if (activeLearners() >= MAX_LEARNERS()) return false; // too many running: skip this turn, a later one re-learns
  const lock = join(LEARNERS_DIR(), `${randomUUID()}.lock`);
  try { mkdirSync(LEARNERS_DIR(), { recursive: true }); writeFileSync(lock, String(Date.now())); } catch { /* proceed without a lock */ }
  // The run records its progress to the activity log; watch it live in the web UI at /skills (cairn ui).
  // No terminal is spawned (that was unreliable across Windows default-terminal setups).
  try {
    const child = spawn(process.platform === "win32" ? "bun.exe" : "bun", [WORKER(), transcriptPath], {
      detached: true,
      stdio: "ignore",
      windowsHide: true, // no console window pops up on Windows (the detached worker is invisible)
      // CAIRN_SKILL_WORKER blocks recursion; CAIRN_READONLY is cleared because the worker WRITES skills
      // (the hook that spawns it runs read-only). CAIRN_LEARNER_LOCK tells the worker which lock to release.
      // CAIRN_REVIEW_LABEL carries the agent-declared skill the worker grades against.
      env: { ...process.env, CAIRN_SKILL_WORKER: "1", CAIRN_READONLY: "", CAIRN_LEARNER_LOCK: lock, CAIRN_REVIEW_LABEL: label },
    });
    child.unref(); // let the parent (the Stop hook) exit immediately
    return true;
  } catch { try { rmSync(lock, { force: true }); } catch { /* ignore */ } return false; }
}
