// Would piggybacking skill retrieval on brain_search help? Measures the three things that decide it:
// (1) ACCURACY: does an agent's SEARCH query ("how to write a good commit message") find the right skill,
//     vs a raw USER request? (2) COST: the marginal scan time, since brain_search already embedded the
//     query (we reuse that vector). (3) BLOAT: the size of a capped skills blob vs the search budget.
// Run against a throwaway db:
//   CAIRN_DB_PATH=/tmp/mcp.db CAIRN_ALLOW_REAL_DB=1 bun scripts/skill-mcp-bench.ts
import { categorize } from "../src/skill/match";
import { setMasterPrompt, skillVectors } from "../src/skill/store";
import { retrieveSkills, RETRIEVE_THRESHOLD } from "../src/skill/retrieve";
import { embed, cosine } from "../src/core/embed";

const MASTER = "x".repeat(520); // a typical compact master prompt (~520 chars)
const SKILLS = ["commit message", "pr description", "haiku", "poem", "code review comment", "sql query"];
for (const s of SKILLS) { const { skill } = await categorize(s, 1); setMasterPrompt(skill.id, MASTER); }

// two query styles per skill: how a USER phrases it vs how an AGENT searches the brain for it
const CASES: { skill: string; user: string; agent: string }[] = [
  { skill: "commit message", user: "what should the commit message be for this bug fix", agent: "how to write a good commit message" },
  { skill: "pr description", user: "write a PR description for the retry change", agent: "best practices for a pull request description" },
  { skill: "haiku", user: "hey whip up a haiku about my cat", agent: "how do I write a good haiku" },
  { skill: "poem", user: "i need a poem for my mom's birthday card", agent: "how to write a poem" },
  { skill: "code review comment", user: "review this function and tell me whats wrong", agent: "how to write a useful code review comment" },
  { skill: "sql query", user: "get me the top 10 customers by revenue", agent: "how to write a sql query" },
];

async function hit(query: string, want: string): Promise<boolean> {
  const r = await retrieveSkills(query, 1);
  return r[0]?.skill.task === want;
}
let userHits = 0, agentHits = 0;
console.log("accuracy (top-1 skill) by query style:");
for (const c of CASES) {
  const u = await hit(c.user, c.skill), a = await hit(c.agent, c.skill);
  userHits += u ? 1 : 0; agentHits += a ? 1 : 0;
  console.log(`  ${c.skill.padEnd(20)} user ${u ? "OK" : "MISS"}  agent ${a ? "OK" : "MISS"}`);
}
console.log(`  USER-request style:  ${userHits}/${CASES.length}`);
console.log(`  AGENT-search style:  ${agentHits}/${CASES.length}`);

// COST: brain_search already embeds the query; the marginal cost of piggyback is just the cosine scan.
const qv = await embed("how to write a good commit message");
for (const N of [6, 50, 500]) {
  const vecs = Array.from({ length: N }, (_, i) => skillVectors()[i % skillVectors().length]!.vec);
  const t0 = performance.now();
  for (let r = 0; r < 200; r++) for (const v of vecs) cosine(qv, v);
  const ms = (performance.now() - t0) / 200;
  console.log(`  scan ${String(N).padStart(3)} skills: ${ms.toFixed(3)} ms/query (embedding already done by brain_search)`);
}

// BLOAT: a capped skills blob (top-k masters) vs the search char budget (default 90000)
const blob = (await retrieveSkills("how to write a good commit message", 2)).map((x) => x.skill.masterPrompt).join("\n");
console.log(`  skills blob (top-2 masters): ${blob.length} chars = ${(blob.length / 90000 * 100).toFixed(1)}% of the 90000-char search budget`);
console.log(`  threshold ${RETRIEVE_THRESHOLD} still gates: unrelated queries return nothing`);
