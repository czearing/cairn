// Fresh-start short-story loop against the REAL brain, chasing a 0.9. Clears the skill store + activity,
// then each round: a cairn+web-connected writer drafts a TWO-PARAGRAPH short story (using the learned
// master if any), the learner grades + rewrites the master via the real pipeline (recording to /activity),
// and we stop the moment a round scores >= TARGET. Reports the trajectory and which round hit 0.9.
// Run: bun scripts/skill-shortstory-fresh.ts [maxRounds]
import { existsSync, rmSync } from "node:fs";
import { db } from "../src/core/db";
import { runClaude } from "../src/skill/claude";
import { cairnMcpConfigPath } from "../src/skill/cairn-mcp";
import { processRun } from "../src/skill/pipeline";
import { activityPath } from "../src/skill/activity";
import { retrieveSkill } from "../src/skill/retrieve";

const TASK = "write a short story"; // generic, no topic, as requested
const TARGET = 0.9;
const MAX_ROUNDS = Number(process.argv[2] || 6);

db().run("DELETE FROM skill_runs");
db().run("DELETE FROM skills");
try { if (existsSync(activityPath())) rmSync(activityPath()); } catch { /* none yet */ }
console.log(`cleared store + activity; chasing ${TARGET} on "${TASK}" (two paragraphs), max ${MAX_ROUNDS} rounds\n`);

// The writer may research (web + brain) and follow the learned process; the two-paragraph form is the only
// fixed constraint, the topic is the writer's to choose each round.
const writerTools = { allowedTools: ["WebSearch", "mcp__cairn__brain_search"], mcpConfigPath: cairnMcpConfigPath(), timeoutMs: 300_000 };
const scores: number[] = [];
let hit = 0;

for (let round = 1; round <= MAX_ROUNDS; round++) {
  const master = (await retrieveSkill(TASK))?.skill.masterPrompt || "";
  // Let the writer actually RUN the master's process (research preamble, draft, self-critique vs the rules,
  // revise) instead of forcing "only the story" which suppressed steps 1/4/9. Grade only the final story
  // (after the divider); the learner still sees the whole process as transcript context.
  const prompt = master
    ? `Approach learned from prior runs (follow it fully, including any research preamble and self-review/revision passes it specifies):\n${master}\n\nWork the full process out loud: research notes, a draft, then critique your own draft against every rule above and revise it. End your message with a line containing only ===STORY=== followed by the FINAL short story of exactly two paragraphs, and nothing after it.`
    : `Write a short story of exactly two paragraphs. End your message with a line containing only ===STORY=== followed by the story.`;
  const full = (await runClaude(prompt, writerTools)).text.trim();
  const sep = full.lastIndexOf("===STORY===");
  const story = (sep >= 0 ? full.slice(sep + "===STORY===".length) : full).trim();

  const transcript = full; // the learner sees the whole process: research, draft, self-critique, revision
  const res = await processRun({ request: TASK, transcript, output: story }, Date.now());
  const score = res[0]?.score ?? 0;
  scores.push(score);

  console.log(`==================== round ${round}  score ${score.toFixed(2)}  ${round === 1 ? "(cold)" : "(with learned master)"} ====================\n${story}\n`);
  if (score >= TARGET) { hit = round; break; }
}

console.log("scores by round: " + scores.map((s) => s.toFixed(2)).join(" -> "));
console.log(hit ? `>>> reached ${TARGET} at round ${hit}` : `>>> did NOT reach ${TARGET} in ${MAX_ROUNDS} rounds (best ${Math.max(...scores).toFixed(2)})`);
const final = await retrieveSkill(TASK);
console.log("\n==================== final learned master ====================\n" + (final?.skill.masterPrompt || "(none)"));
