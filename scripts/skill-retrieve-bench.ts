// Does INSTANT retrieval (embed the request, cosine vs skill label vectors) pick the right skill from a
// messy request? Seeds skills, then fires realistic requests and measures top-1 hit rate + the score gap
// to the runner-up (separation). Tells us the right RETRIEVE_THRESHOLD. Throwaway db:
//   CAIRN_DB_PATH=/tmp/ret.db CAIRN_ALLOW_REAL_DB=1 bun scripts/skill-retrieve-bench.ts
import { categorize } from "../src/skill/match";
import { setMasterPrompt } from "../src/skill/store";
import { condenseMessages, retrieveSkill } from "../src/skill/retrieve";
import { embed, cosine } from "../src/core/embed";

const SKILLS = ["haiku", "poem", "pr description", "commit message", "code review comment", "sql query"];
for (const s of SKILLS) { const { skill } = await categorize(s, 1); setMasterPrompt(skill.id, `master prompt for ${s}`); }

const PROBES: { expect: string; messages: string[] }[] = [
  { expect: "haiku", messages: ["hey", "can you whip up a haiku about my cat knocking things over"] },
  { expect: "poem", messages: ["i need a poem for my mom's birthday card"] },
  { expect: "pr description", messages: ["here is my diff", "write a PR description for the retry-logic change"] },
  { expect: "commit message", messages: ["what should the commit message be for this bug fix"] },
  { expect: "code review comment", messages: ["review this function and tell me what is wrong"] },
  { expect: "sql query", messages: ["help me get a query for the top 10 customers by revenue"] },
];

// negative probes: unrelated requests that should match NO skill (set the safe floor)
const NEGATIVES = ["what is the weather in tokyo today", "tell me a fun fact about octopuses", "what time is my dentist appointment"];
console.log("negative probes (should score LOW, no injection):");
for (const n of NEGATIVES) {
  const nv = await embed(n);
  const ranked = (await Promise.all(SKILLS.map(async (s) => ({ s, score: cosine(nv, await embed(s)) })))).sort((a, b) => b.score - a.score);
  console.log(`  "${n.slice(0, 34)}" -> top ${ranked[0]!.s} (${ranked[0]!.score.toFixed(2)})`);
}

let hits = 0;
const gaps: number[] = [];
console.log("\nprobe -> top skill (score) [expected]");
for (const p of PROBES) {
  const q = condenseMessages(p.messages);
  const qv = await embed(q);
  // full ranking to see the gap to runner-up
  const ranked = await Promise.all(SKILLS.map(async (s) => ({ s, score: cosine(qv, await embed(s)) })));
  ranked.sort((a, b) => b.score - a.score);
  const top = ranked[0]!, second = ranked[1]!;
  const hit = top.s === p.expect;
  hits += hit ? 1 : 0;
  gaps.push(top.score - second.score);
  console.log(`  ${hit ? "OK " : "MISS"} "${q.slice(0, 40)}" -> ${top.s} (${top.score.toFixed(2)}), 2nd ${second.s} (${second.score.toFixed(2)}) [${p.expect}]`);
  const r = await retrieveSkill(q); // exercise the real path
  if (r && r.skill.task !== p.expect) console.log(`     retrieveSkill returned ${r.skill.task}`);
}
console.log(`\nhit rate: ${hits}/${PROBES.length}`);
console.log(`min top-vs-2nd gap: ${Math.min(...gaps).toFixed(2)}, mean ${(gaps.reduce((a, b) => a + b, 0) / gaps.length).toFixed(2)}`);
