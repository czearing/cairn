#!/usr/bin/env bun
// Long-running story-quality loop. Keeps writing short stories with the LIVE "short story" master, has the
// learner score and refine that master each round, logs every score, and chases 0.9 over a time budget.
// It does NOT wipe the brain: it uses and improves the real skill (the starting master is backed up first so
// nothing is ever lost). Built to run in the background while AFK.
//   bun scripts/story-quality-loop.ts        (defaults: 3h budget, 40-round cap)
//   STORY_LOOP_HOURS=3 STORY_LOOP_MAX=40 bun scripts/story-quality-loop.ts
import { appendFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { runClaude } from "../src/skill/claude";
import { cairnMcpConfigPath } from "../src/skill/cairn-mcp";
import { processRun } from "../src/skill/pipeline";
import { retrieveSkill } from "../src/skill/retrieve";

const TASK = "write a short story";
const TARGET = 0.9;
const TIME_BUDGET_MS = Number(process.env.STORY_LOOP_HOURS || "3") * 3_600_000;
const MAX_ROUNDS = Number(process.env.STORY_LOOP_MAX || "40");
const LOG = process.env.STORY_LOOP_LOG || join(homedir(), ".cairn", "story-loop.log");
const BACKUP = join(homedir(), ".cairn", "short-story-master.backup.txt");

const log = (o: object) => appendFileSync(LOG, JSON.stringify({ t: new Date().toISOString(), ...o }) + "\n");

const start = Date.now();
const startMaster = (await retrieveSkill(TASK))?.skill.masterPrompt || "";
writeFileSync(BACKUP, startMaster);                       // restore point in case the loop degrades the master
writeFileSync(LOG, "");                                   // fresh log for this run
log({ event: "start", target: TARGET, budgetMs: TIME_BUDGET_MS, maxRounds: MAX_ROUNDS, startMasterChars: startMaster.length, backup: BACKUP });

const writerTools = { allowedTools: ["WebSearch", "mcp__cairn__brain_search"], mcpConfigPath: cairnMcpConfigPath(), timeoutMs: 600_000 }; // 10 min: the full research+draft+review+revise process needs room
const extract = (r: { text: string }) => {
  const full = r.text.trim();
  const sep = full.lastIndexOf("===STORY===");
  return { full, story: (sep >= 0 ? full.slice(sep + "===STORY===".length) : full).trim() };
};

const scores: number[] = [];
let round = 0, firstHit: number | null = null;
while (Date.now() - start < TIME_BUDGET_MS && round < MAX_ROUNDS) {
  round++;
  const master = (await retrieveSkill(TASK))?.skill.masterPrompt || "";
  const prompt = master
    ? `Approach learned from prior runs (follow it fully, including any research preamble and self-review/revision passes it specifies):\n${master}\n\nWork the full process out loud: research notes, a draft, then critique your own draft against every rule above and revise it. End your message with a line containing only ===STORY=== followed by the FINAL short story of exactly two paragraphs, and nothing after it.`
    : `Write a short story of exactly two paragraphs. End your message with a line containing only ===STORY=== followed by the story.`;

  let r = await runClaude(prompt, writerTools);
  let { full, story } = extract(r);
  if (!r.ok || !story) { r = await runClaude(prompt, writerTools); ({ full, story } = extract(r)); } // one retry
  if (!r.ok || !story) { log({ event: "writer_failed", round, error: r.error }); continue; }

  const res = await processRun({ request: TASK, transcript: full, output: story }, Date.now());
  const score = res[0]?.score ?? 0;
  scores.push(score);
  if (score >= TARGET && firstHit === null) firstHit = round;
  const masterAfter = (await retrieveSkill(TASK))?.skill.masterPrompt || "";
  log({ event: "round", round, score, best: Math.max(...scores), masterChars: masterAfter.length, elapsedMin: Math.round((Date.now() - start) / 60000), story });
}

const best = scores.length ? Math.max(...scores) : 0;
log({ event: "end", rounds: round, graded: scores.length, scores, best, firstHitRound: firstHit, elapsedMin: Math.round((Date.now() - start) / 60000) });
console.log(`done: ${scores.length} graded rounds, best ${best.toFixed(2)}${firstHit ? `, first 0.9 at round ${firstHit}` : ""}`);
process.exit(0);
