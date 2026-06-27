#!/usr/bin/env bun
// One-time migration: existing skills store the rationale paragraph + numbered steps together in
// master_prompt. Split each one so master_prompt holds the steps only (what the doer is injected) and the
// leading rationale moves into the new `explanation` column (reviewer-only). Idempotent: a skill that
// already has an explanation, or whose master has no numbered list to split, is left untouched.
//   bun scripts/migrate-skill-explanation.ts          (apply)
//   bun scripts/migrate-skill-explanation.ts --dry     (preview only)
import { listSkills, setMasterPrompt } from "../src/skill/store";
import { reindexSkill } from "../src/skill/match";
import { splitMaster } from "../src/skill/split-master";

const dry = process.argv.includes("--dry");

let migrated = 0, skipped = 0, unchanged = 0;
for (const s of listSkills()) {
  if ((s.explanation ?? "").trim()) { skipped++; continue; }          // already split
  const parts = splitMaster(s.masterPrompt);
  if (!parts || !parts.explanation) { unchanged++; continue; }        // pure steps already, or no list: leave it
  console.log(`"${s.task}": explanation ${parts.explanation.length} chars | instructions ${parts.instructions.length} chars`);
  if (!dry) { setMasterPrompt(s.id, parts.instructions, parts.explanation); await reindexSkill(s.id, s.task, parts.instructions); }
  migrated++;
}
console.log(`\n${dry ? "[dry] would migrate" : "migrated"} ${migrated}, already-split ${skipped}, no-rationale ${unchanged}`);
process.exit(0);
