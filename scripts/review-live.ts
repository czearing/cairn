// Live proof the cairn-connected learner grades an output against a skill's prior runs: a weak haiku
// should score below a strong one. The learner is stateless (the labeler was folded in), so prior runs
// are passed in the prompt, not via a resumed session. Prints the learn system prompt to monitor.
// Throwaway db:  CAIRN_DB_PATH=/tmp/review.db CAIRN_ALLOW_REAL_DB=1 bun scripts/review-live.ts
import { LEARN_SYSTEM } from "../src/skill/prompts";
import { categorize } from "../src/skill/match";
import { addRun, topRuns } from "../src/skill/store";
import { reviewAndLearn } from "../src/skill/reviewer";

const { skill } = await categorize("haiku", 1);
addRun({ skillId: skill.id, recipe: "draft | count 5-7-5", quality: 0.6, review: "imagery was generic, ending weak", ts: 1 });

console.log("=== LEARN SYSTEM PROMPT (monitor) ===\n" + LEARN_SYSTEM + "\n");

const WEAK = "frost on the window\ncold morning light comes slowly\nwinter is so so cold";
console.log("--- grade WEAK ---");
const r1 = (await reviewAndLearn("write a haiku", WEAK, "", ["haiku"], topRuns(skill.id, 10))).review;
console.log(JSON.stringify(r1, null, 0));

const STRONG = "first frost on the gate\na sparrow tilts its small head\nthe whole field holds still";
console.log("--- grade STRONG ---");
const r2 = (await reviewAndLearn("write a haiku", STRONG, "", ["haiku"], topRuns(skill.id, 10))).review;
console.log(JSON.stringify(r2, null, 0));

console.log(`\nstrong (${r2?.score}) > weak (${r1?.score}): ${(r2?.score ?? 0) > (r1?.score ?? 0) ? "QUALITY ORDER OK" : "CHECK"}`);
