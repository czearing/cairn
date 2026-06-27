// Continue the short-story skill FROM the prior tests' baseline master (best ~0.76), instead of relearning
// cold. We seed the skill with the distilled baseline master, then run N rounds that keep refining it via the
// real pipeline. Round 1 already uses the good master, so the curve starts at the plateau and tries to climb.
// Run: bun scripts/skill-shortstory-continue.ts [maxRounds]
import { existsSync, rmSync } from "node:fs";
import { db } from "../src/core/db";
import { runClaude } from "../src/skill/claude";
import { cairnMcpConfigPath } from "../src/skill/cairn-mcp";
import { processRun } from "../src/skill/pipeline";
import { activityPath } from "../src/skill/activity";
import { retrieveSkill } from "../src/skill/retrieve";
import { categorize, reindexSkill } from "../src/skill/match";
import { setMasterPrompt } from "../src/skill/store";
import { BASELINE_MASTER } from "./shortstory-baseline";

const TASK = "write a short story";
const LABEL = "short story";
const TARGET = 0.9;
const MAX_ROUNDS = Number(process.argv[2] || 10);

// Start clean of the cold round-1 garbage, then SEED the baseline master so round 1 builds on it.
db().run("DELETE FROM skill_runs");
db().run("DELETE FROM skills");
const seedNow = Date.now();
const { skill: seeded } = await categorize(LABEL, seedNow);
setMasterPrompt(seeded.id, BASELINE_MASTER);
await reindexSkill(seeded.id, LABEL, BASELINE_MASTER);
try { if (existsSync(activityPath())) rmSync(activityPath()); } catch { /* none yet */ }
console.log(`seeded baseline master (${BASELINE_MASTER.length} chars); chasing ${TARGET} on "${TASK}", max ${MAX_ROUNDS} rounds (continuing FROM baseline, not cold)\n`);

const writerTools = { allowedTools: ["WebSearch", "mcp__cairn__brain_search"], mcpConfigPath: cairnMcpConfigPath(), timeoutMs: 300_000 };
const scores: number[] = [];
const fails: number[] = [];
let hit = 0;

for (let round = 1; round <= MAX_ROUNDS; round++) {
  const master = (await retrieveSkill(TASK))?.skill.masterPrompt || "";
  // The writer runs the master's full process (research preamble, draft, self-critique, revise) and ends with
  // a divider; we grade only the final story, while the learner still sees the whole process as transcript.
  const prompt = master
    ? `Approach learned from prior runs (follow it fully, including any research preamble and self-review/revision passes it specifies):\n${master}\n\nWork the full process out loud: research notes, a draft, then critique your own draft against every rule above and revise it. End your message with a line containing only ===STORY=== followed by the FINAL short story of exactly two paragraphs, and nothing after it.`
    : `Write a short story of exactly two paragraphs. End your message with a line containing only ===STORY=== followed by the story.`;
  const extract = (r: { ok: boolean; text: string; error?: string }) => {
    const full = r.text.trim();
    const sep = full.lastIndexOf("===STORY===");
    return { full, story: (sep >= 0 ? full.slice(sep + "===STORY===".length) : full).trim() };
  };
  // Explicit failure handling: a failed/empty writer call is NOT a 0.02 story (that pollutes the trajectory
  // and violates the explicit-failure rule). Retry once, then record the round as a failed generation and
  // skip grading entirely so only real deliverables are scored.
  let r = await runClaude(prompt, writerTools);
  let { full, story } = extract(r);
  if (!r.ok || !story) {
    console.log(`-------------------- round ${round}  WRITER FAILED (${r.ok ? "empty story" : r.error}); retrying once --------------------`);
    r = await runClaude(prompt, writerTools);
    ({ full, story } = extract(r));
  }
  if (!r.ok || !story) {
    fails.push(round);
    console.log(`==================== round ${round}  FAILED GENERATION (${r.ok ? "empty after retry" : r.error}); NOT graded ====================\n`);
    continue;
  }

  const res = await processRun({ request: TASK, transcript: full, output: story }, Date.now());
  const score = res[0]?.score ?? 0;
  scores.push(score);

  console.log(`==================== round ${round}  score ${score.toFixed(2)} ====================\n${story}\n`);
  if (score >= TARGET) { hit = round; break; }
}

console.log("real scores (graded rounds only): " + (scores.length ? scores.map((s) => s.toFixed(2)).join(" -> ") : "(none)"));
if (fails.length) console.log(`failed generations (writer returned nothing, NOT graded): rounds ${fails.join(", ")}`);
console.log(hit ? `>>> reached ${TARGET} at round ${hit}` : `>>> did NOT reach ${TARGET} (best ${scores.length ? Math.max(...scores).toFixed(2) : "n/a"} over ${scores.length} graded rounds)`);
const final = await retrieveSkill(TASK);
console.log("\n==================== final learned master ====================\n" + (final?.skill.masterPrompt || "(none)"));
