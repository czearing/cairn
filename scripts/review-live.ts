// Live proof of step 7: the cairn-connected reviewer scores an output for a skill against its prior runs,
// and its session PERSISTS per skill (first run starts it, second --resumes the same conversation). Prints
// the reviewer system prompt to monitor. Throwaway db:
//   CAIRN_DB_PATH=/tmp/review.db CAIRN_ALLOW_REAL_DB=1 bun scripts/review-live.ts
import { REVIEW_SYSTEM } from "../src/skill/prompts";
import { categorize } from "../src/skill/match";
import { addRun, hasSession } from "../src/skill/store";
import { reviewOutput } from "../src/skill/reviewer";

const { skill } = await categorize("haiku", 1);
addRun({ skillId: skill.id, recipe: "draft | count 5-7-5", quality: 0.6, review: "imagery was generic, ending weak", ts: 1 });

console.log("=== REVIEW SYSTEM PROMPT (monitor) ===\n" + REVIEW_SYSTEM + "\n");
console.log(`skill ${skill.id.slice(0, 8)} (haiku), session started before: ${hasSession(skill.id)}\n`);

const WEAK = "frost on the window\ncold morning light comes slowly\nwinter is so so cold";
console.log("--- first review (STARTS the session) ---");
const r1 = await reviewOutput(skill.id, "haiku", WEAK);
console.log(JSON.stringify(r1, null, 0));
console.log("session persisted now:", hasSession(skill.id), "\n");

const STRONG = "first frost on the gate\na sparrow tilts its small head\nthe whole field holds still";
console.log("--- second review (RESUMES the same session) ---");
const r2 = await reviewOutput(skill.id, "haiku", STRONG);
console.log(JSON.stringify(r2, null, 0));

console.log(`\nstrong (${r2?.score}) > weak (${r1?.score}): ${(r2?.score ?? 0) > (r1?.score ?? 0) ? "QUALITY ORDER OK" : "CHECK"}`);
