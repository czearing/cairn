// Detached background learner: reads a turn's transcript and grades it against the skill the agent DECLARED
// via skill_review (passed as CAIRN_REVIEW_LABEL/FOCUS). Spawned by learnFromTranscript with
// CAIRN_SKILL_WORKER=1 so it can never recurse. Not meant to be run by hand.
import { extractRun } from "../src/skill/transcript";
import { extractRunCopilot } from "../src/skill/transcript-copilot";
import { reviewDeclared } from "../src/skill/pipeline";

process.env.CAIRN_SKILL_WORKER = "1"; // belt-and-suspenders loop guard
const transcriptPath = process.argv[2];
const label = process.env.CAIRN_REVIEW_LABEL ?? "";
const focus = process.env.CAIRN_REVIEW_FOCUS ?? "";
if (!transcriptPath || !label.trim()) process.exit(1); // nothing to grade without a declared skill
try {
  // Pick the transcript parser for the host that produced it: Copilot's events.jsonl vs Claude's message-JSONL.
  const backend = (process.env.CAIRN_LEARN_BACKEND || "").trim().toLowerCase();
  const input = (backend === "copilot" ? extractRunCopilot : extractRun)(transcriptPath);
  if (input) await reviewDeclared(input, label, focus, Date.now());
} catch { /* best-effort background work; never surface */ }
finally {
  // Release this worker's concurrency-cap lock so the next learner can run (learn.ts counts these files).
  const lock = process.env.CAIRN_LEARNER_LOCK;
  if (lock) { try { (await import("node:fs")).rmSync(lock, { force: true }); } catch { /* ignore */ } }
}
process.exit(0); // the coordinator may have polled; do not let any timer keep us alive
