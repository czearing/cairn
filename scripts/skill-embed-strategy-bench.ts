// Fix the synonym bug (a "pull request description" query missing the "pr description" skill) the smart
// way: embed the skill's DOMAIN VOCABULARY (label + master prompt), not the bare label, so "pull request"
// lives in the skill's vector. Compares label-only vs label+master on real cross-phrasing queries AND on
// selectivity (a short story must still draw poem, not git). Run: bun scripts/skill-embed-strategy-bench.ts
import { embed, cosine } from "../src/core/embed";

const SKILLS: Record<string, string> = {
  "pr description": "Write a pull request description. Inspect the diff, summarize what changed and why, note breaking changes, list how it was tested. Imperative title.",
  "commit message": "Write a git commit message. Imperative subject under 50 chars, explain what changed and why, reference the issue or ticket.",
  "haiku": "Write a haiku. Strict 5-7-5 syllables, one concrete seasonal kigo, a kireji turn, cut all filler and cliche.",
  "poem": "Write a poem. Concrete sensory imagery over abstraction, a genuine volta, ruthless economy, best words in best order.",
  "code review comment": "Write a code review comment. Point at the specific line, explain the issue and its risk, suggest a concrete fix, stay kind.",
  "sql query": "Write a SQL query. Select only needed columns, join correctly, filter and group, order and limit, mind index performance.",
};
const labels = Object.keys(SKILLS);

const QUERIES: { want: string; q: string }[] = [
  { want: "pr description", q: "best practices for a pull request description" }, // the bug
  { want: "pr description", q: "write a PR description for the retry change" },
  { want: "commit message", q: "how to write a good commit message" },
  { want: "haiku", q: "how do I write a good haiku" },
  { want: "poem", q: "i need a poem for my mom's birthday card" },
  { want: "code review comment", q: "review this function and tell me whats wrong" },
  { want: "sql query", q: "get me the top 10 customers by revenue" },
];

const labelVec = Object.fromEntries(await Promise.all(labels.map(async (l) => [l, await embed(l)] as const)));
const richVec = Object.fromEntries(await Promise.all(labels.map(async (l) => [l, await embed(`${l}. ${SKILLS[l]}`)] as const)));

async function rank(qv: number[], vecs: Record<string, number[]>) {
  return labels.map((l) => ({ l, score: cosine(qv, vecs[l]!) })).sort((a, b) => b.score - a.score);
}
let labelHits = 0, richHits = 0;
console.log("query -> top-1 [want]   label-only | label+master");
for (const { want, q } of QUERIES) {
  const qv = await embed(q);
  const lr = await rank(qv, labelVec), rr = await rank(qv, richVec);
  const lOk = lr[0]!.l === want, rOk = rr[0]!.l === want;
  labelHits += lOk ? 1 : 0; richHits += rOk ? 1 : 0;
  console.log(`  "${q.slice(0, 38)}" [${want}]  ${lOk ? "OK" : "MISS"} (${lr[0]!.score.toFixed(2)}) | ${rOk ? "OK" : "MISS"} (${rr[0]!.score.toFixed(2)})`);
}
console.log(`\nhit rate:  label-only ${labelHits}/${QUERIES.length}   label+master ${richHits}/${QUERIES.length}`);

// selectivity must survive: a short story draws poem, never a dev skill
const sv = await embed("write me a short story about a lonely lighthouse keeper who finds a message in a bottle");
const sel = await rank(sv, richVec);
console.log(`\nselectivity (short story, label+master): top ${sel[0]!.l} (${sel[0]!.score.toFixed(2)}), then ${sel[1]!.l} (${sel[1]!.score.toFixed(2)})`);
console.log(`  creative-not-dev: ${["poem", "haiku"].includes(sel[0]!.l) ? "OK" : "BAD"}`);
