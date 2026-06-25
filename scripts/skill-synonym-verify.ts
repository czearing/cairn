// Verify the max-of-both fix through the REAL retrieveSkills path: a "pull request description" query must
// now match the "pr description" skill, code review must still match, and a short story must still draw
// poem (selectivity preserved). Throwaway db:
//   CAIRN_DB_PATH=/tmp/syn.db CAIRN_ALLOW_REAL_DB=1 bun scripts/skill-synonym-verify.ts
import { categorize, reindexSkill } from "../src/skill/match";
import { setMasterPrompt } from "../src/skill/store";
import { retrieveSkills } from "../src/skill/retrieve";

const SKILLS: Record<string, string> = {
  "pr description": "Write a pull request description. Inspect the diff, summarize what changed and why, note breaking changes, list testing.",
  "commit message": "Write a git commit message. Imperative subject under 50 chars, explain what and why, reference the issue.",
  "code review comment": "Write a code review comment. Point at the specific line, explain the issue and risk, suggest a concrete fix.",
  "haiku": "Write a haiku. Strict 5-7-5, one concrete kigo, a kireji turn, cut filler.",
  "poem": "Write a poem. Concrete sensory imagery, a volta, ruthless economy, best words in best order.",
};
for (const [label, master] of Object.entries(SKILLS)) {
  const { skill } = await categorize(label, 1);
  setMasterPrompt(skill.id, master);
  await reindexSkill(skill.id, label, master); // build the rich vector
}

const PROBES: { want: string; q: string }[] = [
  { want: "pr description", q: "best practices for a pull request description" }, // the bug
  { want: "code review comment", q: "review this function and tell me whats wrong" },
  { want: "commit message", q: "how to write a good commit message" },
  { want: "poem", q: "write me a short story about a lonely lighthouse keeper" }, // selectivity: creative, not dev
];
let pass = 0;
for (const { want, q } of PROBES) {
  const r = await retrieveSkills(q, 2);
  const top = r[0];
  const ok = top?.skill.task === want;
  pass += ok ? 1 : 0;
  console.log(`  ${ok ? "OK  " : "MISS"} "${q.slice(0, 44)}" -> ${top ? `${top.skill.task} (${top.score.toFixed(2)})` : "none"} [want ${want}]`);
}
console.log(`\n${pass}/${PROBES.length} (pull-request synonym + code review + selectivity)`);
