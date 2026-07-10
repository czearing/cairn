// Detached background learner: reads a turn's transcript and grades it against the skill the agent DECLARED
// via skill_review (passed as CAIRN_REVIEW_ID). Spawned by learnFromTranscript with CAIRN_SKILL_WORKER=1 so
// it can never recurse. Not meant to be run by hand.
import { extractRun } from "../src/skill/transcript";
import { extractRunCopilot } from "../src/skill/transcript-copilot";
import { reviewDeclared } from "../src/skill/pipeline";
import { completeReviewJob, failReviewJob, heartbeatReviewJob, reviewHeartbeatMs } from "../src/skill/review-queue";
import { drainReviewQueue } from "../src/skill/learn";

process.env.CAIRN_SKILL_WORKER = "1"; // belt-and-suspenders loop guard
const transcriptPath = process.argv[2];
const skillId = process.env.CAIRN_REVIEW_ID ?? "";
const jobId = process.env.CAIRN_REVIEW_JOB_ID ?? "";
const attempt = Number(process.env.CAIRN_REVIEW_ATTEMPT || "0");
if (!transcriptPath || !skillId.trim()) process.exit(1); // nothing to grade without a declared skill id
let completed = false;
let error = "";
const heartbeat = jobId && attempt > 0
  ? setInterval(() => heartbeatReviewJob(jobId, attempt), reviewHeartbeatMs())
  : undefined;
try {
  // Pick the transcript parser for the host that produced it: Copilot's events.jsonl vs Claude's message-JSONL.
  const backend = (process.env.CAIRN_LEARN_BACKEND || "").trim().toLowerCase();
  const input = (backend === "copilot" ? extractRunCopilot : extractRun)(transcriptPath);
  if (!input) error = "transcript contained no reviewable deliverable";
  else completed = Boolean(await reviewDeclared(input, skillId, Date.now()));
  if (!completed && !error) error = "review did not complete";
} catch (e) {
  error = e instanceof Error ? e.message : String(e);
}
finally {
  if (heartbeat) clearInterval(heartbeat);
  if (jobId) {
    if (completed) completeReviewJob(jobId, attempt);
    else failReviewJob(jobId, error || "review failed", attempt);
    try { drainReviewQueue(); } catch { /* a later hook resumes pending work */ }
  }
}
process.exit(0); // the coordinator may have polled; do not let any timer keep us alive
