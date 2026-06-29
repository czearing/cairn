// Prune named skills from the store (skill + its runs). Usage: bun scripts/prune-skills.ts "label one" "label two"
// Reports each as removed or not-found. Exact-label only (no fuzzy), so it can never delete the wrong skill.
import { deleteSkillByLabel, listSkills } from "../src/skill/store";

const labels = process.argv.slice(2);
if (!labels.length) { console.log("usage: bun scripts/prune-skills.ts <label> [<label> ...]"); process.exit(1); }

for (const label of labels) {
  const removed = deleteSkillByLabel(label);
  console.log(`${removed ? "removed" : "not found"}: ${label}`);
}
console.log("\nremaining skills:", listSkills().map((s) => s.task).join(", "));
