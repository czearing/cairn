// Fresh-start haiku loop against the REAL brain. Clears the skill store + activity log, then runs N rounds
// through the real pipeline (processRun), so each round is graded, stored, and recorded to /activity. Watch
// it live at `cairn ui` -> http://localhost:3737/activity.
// Run: bun scripts/skill-haiku-fresh.ts [rounds]
import { existsSync, rmSync } from "node:fs";
import { db } from "../src/core/db";
import { runClaude } from "../src/skill/claude";
import { cairnMcpConfigPath } from "../src/skill/cairn-mcp";
import { processRun } from "../src/skill/pipeline";
import { activityPath } from "../src/skill/activity";
import { retrieveSkill } from "../src/skill/retrieve";

const TASK = "write a haiku";
const ROUNDS = Number(process.argv[2] || 3);

// 1. Clear the skill store and the activity feed so we start from scratch.
db().run("DELETE FROM skill_runs");
db().run("DELETE FROM skills");
try { if (existsSync(activityPath())) rmSync(activityPath()); } catch { /* none yet */ }
console.log(`cleared skills + skill_runs + activity log; running ${ROUNDS} rounds of "${TASK}"\n`);

// The writer is cairn-connected (can brain_search to avoid repeating a past haiku) but otherwise free.
const writerTools = { allowedTools: ["mcp__cairn__brain_search"], mcpConfigPath: cairnMcpConfigPath(), timeoutMs: 180_000 };
const scores: number[] = [];

for (let round = 1; round <= ROUNDS; round++) {
  const cand = await retrieveSkill(TASK);
  const master = cand?.skill.masterPrompt || "";
  const prompt = master
    ? `Approach learned from prior runs:\n${master}\n\nNow ${TASK}. Output only the haiku, three lines, no commentary.`
    : `${TASK}. Output only the haiku, three lines, no commentary.`;
  const output = (await runClaude(prompt, writerTools)).text.trim();

  // Run the real loop: grade + label + master-rewrite + store, recording start/learned to the activity log.
  const transcript = `[user] ${TASK}\n[assistant] ${output}`;
  const res = await processRun({ request: TASK, transcript, output }, Date.now());
  const score = res[0]?.score ?? 0;
  scores.push(score);

  console.log(`==================== round ${round}  score ${score.toFixed(2)}  ${round === 1 ? "(cold, no master)" : "(with learned master)"} ====================`);
  console.log(output + "\n");
}

console.log("scores by round: " + scores.map((s) => s.toFixed(2)).join(" -> "));
const final = await retrieveSkill(TASK);
console.log("\n==================== final learned master ====================\n" + (final?.skill.masterPrompt || "(none)"));
