#!/usr/bin/env bun
// Preview EXACTLY what the skill layer would inject for a given prompt, without talking to Claude.
//   bun scripts/show-injection.ts "write me a haiku about frost"
// Shows the matched skills + scores, the raw injected text (what the doer agent receives), and each
// skill's reviewer-only explanation (which is NOT injected) so you can see the split.
import { condenseMessages, retrieveSkills, skillInstructions, explainInjection, injectionText } from "../src/skill/retrieve";
import { getSkill } from "../src/skill/store";

const query = process.argv.slice(2).join(" ").trim();
if (!query) { console.error('usage: bun scripts/show-injection.ts "<your prompt>"'); process.exit(1); }

const matches = await retrieveSkills(condenseMessages([query]));
const skills = matches.map((m) => m.skill);
const injected = injectionText(skillInstructions(skills), explainInjection(skills));

console.log(`QUERY: ${query}\n`);
if (!matches.length) { console.log("matched 0 skills, nothing would be injected."); process.exit(0); }

console.log(`matched ${matches.length} skill(s): ${matches.map((m) => `${m.skill.task} (${m.score.toFixed(3)})`).join(", ")}\n`);
console.log("===== RAW INJECTED PROMPT (what the doer agent receives) =====\n");
console.log(injected || "(empty)");
console.log("\n===== REVIEWER-ONLY EXPLANATION (NOT injected) =====\n");
for (const m of matches) {
  const full = getSkill(m.skill.id);
  console.log(`## ${m.skill.task}\n${full?.explanation?.trim() || "(none yet)"}\n`);
}
process.exit(0);
