// Live proof of the model-graded loop: real `claude -p` grades (no API key), saved into a task, then
// the skills reordered by the model's score. Run against a THROWAWAY db:
//   CAIRN_DB_PATH=/tmp/grade-live.db CAIRN_ALLOW_REAL_DB=1 bun scripts/grade-live.ts
import { gradeRun } from "../src/core/grader";
import { logRun, appendToRun, topRuns } from "../src/core/cases";

const TASK = "write a haiku";
const RUBRIC = "5-7-5 syllables, vivid concrete imagery, a seasonal turn";
const GOOD = "old pond, still water\na frog leaps into the deep\nthe sound of water";
const BAD = "i wrote a poem ok\nit is about some stuff here\nthe end thanks bye now";
const n = (x: number | null | undefined) => (x == null || Number.isNaN(x) ? "null" : x.toFixed(2));

console.log("=== A1: excellent vs broken (live model grade) ===");
const g = await gradeRun(TASK, GOOD, { rubric: RUBRIC });
const b = await gradeRun(TASK, BAD, { rubric: RUBRIC });
console.log(`  good = ${n(g?.score)}  (${g?.reason ?? "ungraded"})`);
console.log(`  bad  = ${n(b?.score)}  (${b?.reason ?? "ungraded"})`);
console.log(`  A1 ${g && b && g.score > b.score ? "PASS" : "FAIL"}  (gap ${g && b ? n(g.score - b.score) : "n/a"})`);

console.log("\n=== A2: repeatability (same output x3) ===");
const reps: number[] = [];
for (let i = 0; i < 3; i++) { const v = await gradeRun(TASK, GOOD, { rubric: RUBRIC }); reps.push(v ? v.score : NaN); }
const mean = reps.reduce((a, c) => a + c, 0) / reps.length;
const sd = Math.sqrt(reps.reduce((a, c) => a + (c - mean) ** 2, 0) / reps.length);
console.log(`  scores = [${reps.map(n).join(", ")}]  mean ${n(mean)}  stdev ${n(sd)}`);

console.log("\n=== D1/E1: grade -> save into task -> reorder skills ===");
const goodId = logRun({ task: TASK, ts: 1, recipe: ["research_form", "creative", "syllable_check"], times: {}, quality: 0.5 });
const badId = logRun({ task: TASK, ts: 2, recipe: ["just_write"], times: {}, quality: 0.5 });
if (g) appendToRun(goodId, { quality: g.score, review: JSON.stringify(g) });
if (b) appendToRun(badId, { quality: b.score, review: JSON.stringify(b) });
const ranked = topRuns(TASK, 5);
console.log("  ranked by model quality:");
ranked.forEach((r, i) => console.log(`   ${i + 1}. q=${n(r.quality)}  recipe=[${r.recipe.join(", ")}]  review=${r.review?.slice(0, 60)}`));
console.log(`  D1 ${ranked[0]?.recipe.includes("creative") ? "PASS" : "FAIL"}  (best recipe ranked first)`);
