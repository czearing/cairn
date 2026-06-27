// Proof: does the skill loop DISCOVER a creative process for a poem, on its own, when the writer is free
// to research (web + brain) and given minimal guidance? Each round writes the poem (round 1 cold, then
// only with the master the loop itself assembled), reviews it (cairn-connected reviewer, persistent
// session), stores the run, and reassembles + PERSISTS the master. We print the scores and the converged
// master so you can see whether a real process (research, gather, draft, revise) emerged without us
// prescribing it. Run: bun scripts/skill-poem-loop.ts
import { categorize, reindexSkill } from "../src/skill/match";
import { addRun, setMasterPrompt, topRuns } from "../src/skill/store";
import { reviewAndLearn } from "../src/skill/reviewer";
import { runClaude } from "../src/skill/claude";
import { cairnMcpConfigPath } from "../src/skill/cairn-mcp";

const TASK = "write an original poem about the last lit window on a winter street";
const ROUNDS = 5;
const { skill } = await categorize("poem", Date.now());

// The writer may research (web + brain) and revise; we never tell it HOW to write a poem. Any process
// it follows must come from the master the loop assembled, not from us.
const writerTools = { allowedTools: ["WebSearch", "mcp__cairn__brain_search"], mcpConfigPath: cairnMcpConfigPath(), timeoutMs: 240_000 };

let master = skill.masterPrompt || "";
const scores: number[] = [];
let lastPoem = "";
for (let round = 1; round <= ROUNDS; round++) {
  const prompt = master
    ? `Approach learned from prior runs:\n${master}\n\nNow ${TASK}. Output only the poem.`
    : `${TASK}. Output only the poem.`;
  lastPoem = (await runClaude(prompt, writerTools)).text.trim();
  const { review, master: m } = await reviewAndLearn(TASK, lastPoem, `[user] ${TASK}\n[assistant] ${lastPoem}`, [], topRuns(skill.id, 10)); // one call: label + grade + rewrite master
  const score = review?.score ?? 0;
  scores.push(score);
  addRun({ skillId: skill.id, recipe: "round " + round, quality: score, review: review ? JSON.stringify(review) : "", ts: Date.now() + round });
  if (m) { master = m; setMasterPrompt(skill.id, m); await reindexSkill(skill.id, "poem", m); }
  console.log(`\n==================== round ${round}  score ${score.toFixed(2)}  ${round === 1 ? "(cold, no master)" : "(with learned master)"} ====================\n` + lastPoem);
}

console.log("\nscores by round: " + scores.map((s) => s.toFixed(2)).join(" -> "));
console.log(`cold -> final lift: ${(scores[scores.length - 1]! - scores[0]!).toFixed(2)}`);
console.log("\n==================== converged master prompt (the process the loop DISCOVERED) ====================\n" + master);
console.log("\n==================== final poem ====================\n" + lastPoem);
