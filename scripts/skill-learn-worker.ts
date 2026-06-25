// Detached background learner: reads a turn's transcript and runs the whole skill-forming process. Spawned
// by learnFromTranscript with CAIRN_SKILL_WORKER=1 so it can never recurse. Not meant to be run by hand.
import { extractRun } from "../src/skill/transcript";
import { processRun } from "../src/skill/pipeline";

process.env.CAIRN_SKILL_WORKER = "1"; // belt-and-suspenders loop guard
const transcriptPath = process.argv[2];
if (!transcriptPath) process.exit(1);
try {
  const input = extractRun(transcriptPath);
  if (input) await processRun(input, Date.now());
} catch { /* best-effort background work; never surface */ }
