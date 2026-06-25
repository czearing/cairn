// The user's exact scenario: zero brain, ask for "a poem and a haiku" (compound), then ask for each
// separately. Expect TWO skills (poem, haiku), never a merged "poem and haiku" skill, and the separate
// asks must reuse those two with ZERO duplicates. Throwaway db:
//   CAIRN_DB_PATH=/tmp/split.db CAIRN_ALLOW_REAL_DB=1 bun scripts/skill-split-test.ts
import { labelTasks } from "../src/skill/label";
import { categorize } from "../src/skill/match";
import { skillLabels, skillVectors } from "../src/skill/store";

const REQS = [
  "hey can you write me a poem and a haiku about the same rainy afternoon",
  "write me a poem about my grandmother's garden",
  "could you do a quick haiku about the first snow",
];

for (const req of REQS) {
  const labels = await labelTasks(req, skillLabels());
  const ids: string[] = [];
  for (const l of labels) ids.push((await categorize(l, 1)).skill.id.slice(0, 8));
  console.log(`"${req.slice(0, 50)}..."\n  labels=${JSON.stringify(labels)} -> ${ids.join(", ")}`);
}

const skills = skillVectors().map((s) => s.task).sort();
console.log(`\nskills in db: ${JSON.stringify(skills)}`);
console.log(`count: ${skills.length} (expect 2: poem, haiku)`);
console.log(`no merged compound skill: ${!skills.some((s) => s.includes(" and ") || s.split(" ").length > 3) ? "OK" : "BAD"}`);
console.log(`no duplicates: ${skills.length === new Set(skills).size ? "OK" : "DUPES"}`);
console.log(`result: ${skills.length === 2 ? "PASS" : "FAIL"}`);
