// Relevance/selectivity test: a "short story" request (no exact skill) should draw from the CREATIVE
// skills (poem, haiku) and NOT from unrelated dev skills (pr description, commit, git). Seeds both
// families, probes cross-task requests, and prints the full ranking + where the 0.30 inject threshold
// cuts. Throwaway db:
//   CAIRN_DB_PATH=/tmp/rel.db CAIRN_ALLOW_REAL_DB=1 bun scripts/skill-relevance-bench.ts
import { categorize } from "../src/skill/match";
import { embed, cosine } from "../src/core/embed";

const SKILLS = ["poem", "haiku", "song lyrics", "pr description", "commit message", "code review comment", "sql query", "git repo setup"];
for (const s of SKILLS) await categorize(s, 1);
const skillVecs = await Promise.all(SKILLS.map(async (s) => ({ s, vec: await embed(s) })));
const THRESH = 0.30;

const PROBES = [
  "write me a short story about a lonely lighthouse keeper who finds a message in a bottle",
  "write a poem about the sea at dawn",
  "set up the git repo and open a draft pull request for the new feature",
];

for (const p of PROBES) {
  const qv = await embed(p);
  const ranked = skillVecs.map(({ s, vec }) => ({ s, score: cosine(qv, vec) })).sort((a, b) => b.score - a.score);
  console.log(`\n"${p.slice(0, 56)}..."`);
  for (const r of ranked) console.log(`  ${r.score >= THRESH ? "INJECT" : "  skip"}  ${r.s.padEnd(20)} ${r.score.toFixed(2)}`);
  const injected = ranked.filter((r) => r.score >= THRESH).map((r) => r.s);
  console.log(`  => injects: ${JSON.stringify(injected)}`);
}
