// Detached background learner: reads a run payload and runs the whole skill-forming process. Spawned by
// learnInBackground with CAIRN_SKILL_WORKER=1 so it can never recurse. Not meant to be run by hand.
import { readFileSync, unlinkSync } from "node:fs";
import { processRun } from "../src/skill/pipeline";

process.env.CAIRN_SKILL_WORKER = "1"; // belt-and-suspenders loop guard
const payload = process.argv[2];
if (!payload) process.exit(1);
try {
  const { input, now } = JSON.parse(readFileSync(payload, "utf8"));
  await processRun(input, now);
} catch { /* best-effort background work; never surface */ }
finally { try { unlinkSync(payload!); } catch { /* already gone */ } }
