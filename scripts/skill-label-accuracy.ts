// Accuracy of skill assignment on REALISTIC messy requests (not clean labels). Labels each request live,
// categorizes it, and checks: same-intent requests land on ONE skill, different intents on DIFFERENT
// skills, and a multi-task request splits into the right skills. Run against a throwaway db:
//   CAIRN_DB_PATH=/tmp/skill-acc.db CAIRN_ALLOW_REAL_DB=1 bun scripts/skill-label-accuracy.ts
import { labelTasks } from "../src/skill/label";
import { categorize } from "../src/skill/match";
import { skillLabels } from "../src/skill/store";

const CASES: { intent: string; req: string }[] = [
  { intent: "haiku", req: "hey can you whip up a haiku about my cat knocking things off the table this morning lol" },
  { intent: "haiku", req: "need a little 5-7-5 for a tattoo, something about the ocean at night" },
  { intent: "haiku", req: "could you do a quick haiku, theme is autumn leaves falling" },
  { intent: "poem", req: "could you put together a poem for my mom's 60th birthday card" },
  { intent: "poem", req: "i want a poem about moving to a new city and missing home" },
  { intent: "sql", req: "help me get a query that pulls the top 10 customers by revenue last quarter" },
  { intent: "sql", req: "how do i write sql to find duplicate emails in the users table" },
];
const MULTI = "can you write me a haiku and also a poem about the same beach trip";

const intentToSkills = new Map<string, Set<string>>();
console.log("=== single-intent messy requests ===");
for (const { intent, req } of CASES) {
  const labels = await labelTasks(req, skillLabels());
  const ids: string[] = [];
  for (const l of labels) ids.push((await categorize(l, 1)).skill.id);
  for (const id of ids) (intentToSkills.get(intent) ?? intentToSkills.set(intent, new Set()).get(intent)!).add(id);
  console.log(`  ${intent.padEnd(6)} labels=${JSON.stringify(labels)} -> skill ${ids.map((i) => i.slice(0, 8)).join(",")}`);
}

console.log("\n=== multi-task request (split) ===");
const mlabels = await labelTasks(MULTI, skillLabels());
const mids = [];
for (const l of mlabels) { const c = await categorize(l, 2); mids.push(`${l}->${c.skill.id.slice(0, 8)} ${c.created ? "NEW" : "matched"}`); }
console.log(`  "${MULTI}"\n  labels=${JSON.stringify(mlabels)}\n  ${mids.join("  |  ")}`);

console.log("\n=== scorecard ===");
let consistent = 0;
for (const [intent, set] of intentToSkills) { const ok = set.size === 1; consistent += ok ? 1 : 0; console.log(`  ${intent.padEnd(6)} -> ${set.size} skill(s) ${ok ? "OK" : "SPLIT (bad)"}`); }
const allIds = new Set([...intentToSkills.values()].flatMap((s) => [...s]));
console.log(`  within-intent consistency: ${consistent}/${intentToSkills.size}`);
console.log(`  distinct skills ${allIds.size} vs intents ${intentToSkills.size} (equal = clean separation): ${allIds.size === intentToSkills.size ? "OK" : "COLLISION"}`);
console.log(`  multi-task split into ${mlabels.length} labels (expect 2): ${mlabels.length === 2 ? "OK" : "BAD"}`);
