// Accuracy on HYPERSPECIFIC dev tasks (PR descriptions, commits, reviews, tests), which are semantically
// closer than haiku/poem, so a harder consistency test. Same checks: same-intent -> one skill, distinct
// intents -> distinct skills, multi-task splits. Throwaway db:
//   CAIRN_DB_PATH=/tmp/skill-dev.db CAIRN_ALLOW_REAL_DB=1 bun scripts/skill-dev-accuracy.ts
import { labelTasks } from "../src/skill/label";
import { categorize } from "../src/skill/match";
import { skillLabels } from "../src/skill/store";

const CASES: { intent: string; req: string }[] = [
  { intent: "pr-desc", req: "can you write a PR description for my change that adds retry logic to the upload path" },
  { intent: "pr-desc", req: "draft the pull request summary for the auth refactor i just finished" },
  { intent: "pr-desc", req: "i need a description for this pull request, it fixes the null check in the parser" },
  { intent: "commit", req: "write me a commit message for fixing the race condition in the queue" },
  { intent: "commit", req: "what should the commit message be for this dependency bump" },
  { intent: "review", req: "review this function and tell me what is wrong with it" },
  { intent: "review", req: "can you look over my code and give some feedback" },
  { intent: "test", req: "write some unit tests for this auth helper" },
  { intent: "test", req: "i need tests covering the edge cases of the parser" },
];
const MULTI = "write a PR description and a commit message for the change that adds caching";

const intentToSkills = new Map<string, Set<string>>();
console.log("=== hyperspecific dev requests ===");
for (const { intent, req } of CASES) {
  const labels = await labelTasks(req, skillLabels());
  const ids: string[] = [];
  for (const l of labels) ids.push((await categorize(l, 1)).skill.id);
  for (const id of ids) (intentToSkills.get(intent) ?? intentToSkills.set(intent, new Set()).get(intent)!).add(id);
  console.log(`  ${intent.padEnd(8)} labels=${JSON.stringify(labels)} -> ${ids.map((i) => i.slice(0, 8)).join(",")}`);
}

console.log("\n=== multi-task ===");
const mlabels = await labelTasks(MULTI, skillLabels());
const mids = [];
for (const l of mlabels) { const c = await categorize(l, 2); mids.push(`${l}->${c.skill.id.slice(0, 8)} ${c.created ? "NEW" : "matched"}`); }
console.log(`  "${MULTI}"\n  labels=${JSON.stringify(mlabels)}\n  ${mids.join("  |  ")}`);

console.log("\n=== scorecard ===");
let consistent = 0;
for (const [intent, set] of intentToSkills) { const ok = set.size === 1; consistent += ok ? 1 : 0; console.log(`  ${intent.padEnd(8)} -> ${set.size} skill(s) ${ok ? "OK" : "SPLIT (bad)"}`); }
const allIds = new Set([...intentToSkills.values()].flatMap((s) => [...s]));
console.log(`  within-intent consistency: ${consistent}/${intentToSkills.size}`);
console.log(`  distinct skills ${allIds.size} vs intents ${intentToSkills.size}: ${allIds.size === intentToSkills.size ? "OK" : "COLLISION"}`);
console.log(`  multi split into ${mlabels.length} (expect 2): ${mlabels.length === 2 ? "OK" : "BAD"}`);
