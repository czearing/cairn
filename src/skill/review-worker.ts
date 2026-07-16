import { rmSync } from "node:fs";
import { extractRun } from "./transcript";
import { extractRunCopilot } from "./transcript-copilot";
import { reviewDeclared } from "./pipeline";
import { withLearnerBackend, type Backend } from "./runner";
import {
  completeReviewJob,
  failReviewJob,
  heartbeatReviewJob,
  reviewHeartbeatMs,
  type ReviewJob,
} from "./review-queue";

export async function processReviewJob(job: ReviewJob): Promise<boolean> {
  let completed = false;
  let error = "";
  const heartbeat = setInterval(() => heartbeatReviewJob(job.id, job.attempts), reviewHeartbeatMs());
  try {
    const copilot = job.backend.startsWith("copilot");
    const input = copilot
      ? extractRunCopilot(job.transcriptPath, job.backend === "copilot-fallback" ? "" : job.skillId, {
          latestTurn: job.backend === "copilot-fallback",
        })
      : extractRun(job.transcriptPath, job.skillId);
    if (!input) error = "transcript contained no reviewable deliverable";
    else completed = Boolean(await withLearnerBackend((copilot ? "copilot" : "claude") as Backend, () =>
      reviewDeclared(input, job.skillId, Date.now())
    ));
    if (!completed && !error) error = "review did not complete";
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause);
  } finally {
    clearInterval(heartbeat);
    const status = completed
      ? (completeReviewJob(job.id, job.attempts) ? "completed" : "running")
      : failReviewJob(job.id, error || "review failed", job.attempts);
    if (process.env.CAIRN_REVIEW_SNAPSHOT === "1" && status === "completed") {
      try { rmSync(job.transcriptPath, { force: true }); } catch { /* cleanup is best-effort */ }
    }
  }
  return completed;
}
