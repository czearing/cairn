// Detached background learner: reads a turn's transcript and grades it against the skill the agent DECLARED
// via skill_review (passed as CAIRN_REVIEW_ID). Spawned by learnFromTranscript with CAIRN_SKILL_WORKER=1 so
// it can never recurse. Not meant to be run by hand.
import { processReviewJob } from "../src/skill/review-worker";

process.env.CAIRN_SKILL_WORKER = "1"; // belt-and-suspenders loop guard
const transcriptPath = process.argv[2];
const skillId = process.env.CAIRN_REVIEW_ID ?? "";
const jobId = process.env.CAIRN_REVIEW_JOB_ID ?? "";
const attempt = Number(process.env.CAIRN_REVIEW_ATTEMPT || "0");
if (!transcriptPath || !skillId.trim()) process.exit(1); // nothing to grade without a declared skill id
await processReviewJob({
  id: jobId,
  sessionId: "",
  skillId,
  transcriptPath,
  backend: (process.env.CAIRN_LEARN_BACKEND || "copilot").trim().toLowerCase(),
  status: "running",
  attempts: attempt,
  error: "",
  createdTs: 0,
  updatedTs: Date.now(),
});
process.exit(0); // the coordinator may have polled; do not let any timer keep us alive
