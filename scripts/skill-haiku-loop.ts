// Proof the loop improves the SAME task over rounds: write the haiku, review it (persistent reviewer,
// remembers prior rounds), store the run, reassemble the master prompt, then write again WITH it. Shows
// the score climbing and the finished haiku each round. Throwaway db:
//   CAIRN_DB_PATH=/tmp/hloop.db CAIRN_ALLOW_REAL_DB=1 bun scripts/skill-haiku-loop.ts
import { categorize } from "../src/skill/match";
import { addRun, topRuns } from "../src/skill/store";
import { reviewAndLearn } from "../src/skill/reviewer";
import { runClaude } from "../src/skill/claude";

const TASK = "write a haiku about the first snow of winter";
const ROUNDS = 4;
const { skill } = await categorize("haiku", 1);

let master = "";
const scores: number[] = [];
let lastHaiku = "";
for (let round = 1; round <= ROUNDS; round++) {
  const prompt = master
    ? `Curated steps (most effective approach, learned from prior runs):\n${master}\n\nNow ${TASK}. Output only the haiku.`
    : `${TASK}. Output only the haiku.`;
  const haiku = (await runClaude(prompt)).text.trim();
  lastHaiku = haiku;
  const { review, master: m } = await reviewAndLearn(TASK, haiku, `[user] ${TASK}\n[assistant] ${haiku}`, [], topRuns(skill.id, 10)); // one call: label + grade + rewrite master
  const score = review?.score ?? 0;
  scores.push(score);
  addRun({ skillId: skill.id, recipe: "draft | count 5-7-5 | revise", quality: score, review: review ? JSON.stringify(review) : "", ts: round });
  master = m ?? master;
  console.log(`=== round ${round}  score ${score.toFixed(2)}  ${round === 1 ? "(cold, no skill)" : "(with learned master)"} ===`);
  console.log(haiku + "\n");
}

console.log("scores by round:", scores.map((s) => s.toFixed(2)).join(" -> "));
console.log(`improvement round1 -> round${ROUNDS}: ${(scores[scores.length - 1]! - scores[0]!).toFixed(2)}`);
console.log("\n=== FINISHED RESULT (final round) ===\n" + lastHaiku);
console.log("\n=== learned master prompt the skill converged to ===\n" + master);
