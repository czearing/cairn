// Soundness check for folding the labeler into the learner: the learner now assigns the label in the same
// call that grades and rewrites the master. Verify on a throwaway db that (1) same-intent requests with
// different topics reuse ONE skill, (2) a distinct task gets a DISTINCT skill, (3) a non-task turn creates
// no skill. Self-contained (sets its own temp db). Run: bun scripts/skill-fold-verify.ts
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
process.env.CAIRN_DB_PATH = join(tmpdir(), `cairn-fold-verify-${randomUUID()}.db`); // isolate from the real brain

const { reviewAndLearn } = await import("../src/skill/reviewer");
const { categorize } = await import("../src/skill/match");
const { retrieveSkill } = await import("../src/skill/retrieve");
const { skillLabels, topRuns, addRun, setMasterPrompt } = await import("../src/skill/store");

// One learn step (mirrors pipeline.processRun's match -> learn -> categorize, minus compaction).
async function step(request: string, output: string, now: number) {
  const candidate = await retrieveSkill(request);
  const priors = candidate ? topRuns(candidate.skill.id, 10) : [];
  const { label, review, master } = await reviewAndLearn(request, output, `[user] ${request}\n[assistant] ${output}`, skillLabels(), priors);
  if (!label) return { request, label: null as string | null, skillId: "" };
  const { skill } = await categorize(label, now);
  addRun({ skillId: skill.id, recipe: "x", quality: review?.score ?? 0, review: "", ts: now });
  if (master) setMasterPrompt(skill.id, master);
  return { request, label, skillId: skill.id, score: review?.score };
}

const a = await step("write me a haiku about the first frost", "first frost on the gate\na sparrow tilts its head\nthe field holds still", 1);
const b = await step("compose a haiku about the summer sea", "blue noon on the bay\na gull drops to the water\nthe wave forgets it", 2);
const c = await step("write a SQL query that counts users per country", "SELECT country, COUNT(*) FROM users GROUP BY country;", 3);
const d = await step("thanks, that is perfect", "you are welcome", 4);

console.log(JSON.stringify({ a, b, c, d }, null, 2));
console.log("\nlabels in store:", skillLabels());
const pass = (b: boolean) => (b ? "PASS" : "FAIL");
console.log("same-intent a,b reuse ONE skill:", pass(!!a.skillId && a.skillId === b.skillId));
console.log("distinct task c is a DIFFERENT skill:", pass(!!c.skillId && c.skillId !== a.skillId));
console.log("non-task d creates NO skill:", pass(d.label === null));
console.log("total skills:", skillLabels().length, "(expect 2)");
