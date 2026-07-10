import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { claimReviewJobs, enqueueReview, failReviewJob, latestCopilotReview, transcriptReviewKey, type ReviewJob } from "./review-queue";

// The async learn trigger. After a turn finishes, the WHOLE skill-forming process (extract the run ->
// learn: label + grade + master, with the raw transcript as context -> categorize -> store) runs in a
// DETACHED background process so it outlives the short Stop hook and never blocks the user.
//
// Loop guard (critical): the learner must never kick off its own skill-forming, or it would recurse
// forever. Two layers stop it: the spawned worker runs `claude -p --setting-sources project` so cairn's
// hooks do not fire inside it, AND CAIRN_SKILL_WORKER=1 is set on the worker so any nested trigger no-ops.
//
// Review submission is durable: callers enqueue first, then a bounded worker pool drains pending jobs.
// Capacity delays a review but never drops it or makes agentStop claim the turn was not reviewed.

export function isSkillWorker(): boolean {
  return process.env.CAIRN_SKILL_WORKER === "1";
}

const WORKER = () => process.env.CAIRN_SKILL_WORKER_PATH || fileURLToPath(new URL("../../scripts/skill-learn-worker.ts", import.meta.url));
const MAX_LEARNERS = () => Number(process.env.CAIRN_MAX_LEARNERS || "4");

function spawnJob(job: ReviewJob): boolean {
  try {
    const child = spawn(process.platform === "win32" ? "bun.exe" : "bun", [WORKER(), job.transcriptPath], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: {
        ...process.env,
        CAIRN_SKILL_WORKER: "1",
        CAIRN_READONLY: "",
        CAIRN_REVIEW_JOB_ID: job.id,
        CAIRN_REVIEW_ATTEMPT: String(job.attempts),
        CAIRN_REVIEW_ID: job.skillId,
        CAIRN_LEARN_BACKEND: job.backend,
      },
    });
    child.unref();
    return true;
  } catch (error) {
    failReviewJob(job.id, error instanceof Error ? error.message : String(error), job.attempts);
    return false;
  }
}

export function drainReviewQueue(): number {
  if (isSkillWorker() && !process.env.CAIRN_REVIEW_JOB_ID) return 0;
  let started = 0;
  for (const job of claimReviewJobs(MAX_LEARNERS())) if (spawnJob(job)) started++;
  return started;
}

export function learnFromTranscript(
  transcriptPath: string,
  skillId: string,
  options: { id?: string; sessionId?: string; backend?: string } = {}
): boolean {
  if (isSkillWorker() || !transcriptPath || !skillId.trim()) return false;
  try {
    const sessionId = options.sessionId ?? "";
    const id = options.id ?? transcriptReviewKey(transcriptPath, skillId, sessionId);
    const accepted = enqueueReview({
      id,
      sessionId,
      skillId,
      transcriptPath,
      backend: options.backend ?? process.env.CAIRN_LEARN_BACKEND ?? "copilot",
    }).accepted;
    if (!accepted) return false;
    drainReviewQueue();
    return true;
  } catch { return false; }
}

export function learnLatestCopilotReview(
  transcriptPath: string,
  sessionId: string,
  options: { skillId?: string; agentId?: string; subagentOnly?: boolean } = {}
): boolean {
  const event = latestCopilotReview(transcriptPath, sessionId, options);
  if (!event) return false;
  return learnFromTranscript(transcriptPath, event.skillId, {
    id: event.id,
    sessionId,
    backend: "copilot",
  });
}
