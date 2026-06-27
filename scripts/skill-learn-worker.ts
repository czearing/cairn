// Detached background learner: reads a turn's transcript and runs the whole skill-forming process. Spawned
// by learnFromTranscript with CAIRN_SKILL_WORKER=1 so it can never recurse. Not meant to be run by hand.
import { basename } from "node:path";
import { extractRun } from "../src/skill/transcript";
import { processRunCoordinated } from "../src/skill/pipeline";

process.env.CAIRN_SKILL_WORKER = "1"; // belt-and-suspenders loop guard
const transcriptPath = process.argv[2];
if (!transcriptPath) process.exit(1);
try {
  const input = extractRun(transcriptPath);
  if (input) {
    // The transcript file is named by the session id, which matches the session that registered its in-flight
    // skill at injection time, so the coordinator can find this run's siblings.
    const session = basename(transcriptPath).replace(/\.jsonl$/, "");
    await processRunCoordinated(input, session, Date.now());
  }
} catch { /* best-effort background work; never surface */ }
process.exit(0); // the coordinator may have polled; do not let any timer keep us alive
