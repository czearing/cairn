// Detached background learner: reads a turn's transcript and runs the whole skill-forming process. Spawned
// by learnFromTranscript with CAIRN_SKILL_WORKER=1 so it can never recurse. Not meant to be run by hand.
import { basename } from "node:path";
import { extractRun } from "../src/skill/transcript";
import { extractRunCopilot } from "../src/skill/transcript-copilot";
import { processRunCoordinated } from "../src/skill/pipeline";

process.env.CAIRN_SKILL_WORKER = "1"; // belt-and-suspenders loop guard
const transcriptPath = process.argv[2];
if (!transcriptPath) process.exit(1);
try {
  // Pick the transcript parser for the host that produced it: Copilot's events.jsonl vs Claude's message-JSONL.
  const backend = (process.env.CAIRN_LEARN_BACKEND || "").trim().toLowerCase();
  const input = (backend === "copilot" ? extractRunCopilot : extractRun)(transcriptPath);
  if (input) {
    // The transcript file is named by the session id, which matches the session that registered its in-flight
    // skill at injection time, so the coordinator can find this run's siblings.
    const session = basename(transcriptPath).replace(/\.jsonl$/, "");
    await processRunCoordinated(input, session, Date.now());
  }
} catch { /* best-effort background work; never surface */ }
finally {
  // Release this worker's concurrency-cap lock so the next learner can run (learn.ts counts these files).
  const lock = process.env.CAIRN_LEARNER_LOCK;
  if (lock) { try { (await import("node:fs")).rmSync(lock, { force: true }); } catch { /* ignore */ } }
}
process.exit(0); // the coordinator may have polled; do not let any timer keep us alive
