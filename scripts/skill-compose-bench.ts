// Flat vs Graph skills, with numbers. FLAT = one full master prompt per task. GRAPH = decompose each
// master into atomic instruction patterns, share identical ones across tasks (link), store each pattern
// once. Measures how much the graph CONDENSES a family of related tasks and how many patterns are shared.
// Live generation + real MiniLM clustering. Throwaway db not needed (no writes). Run:
//   bun scripts/skill-compose-bench.ts
import { runClaude } from "../src/skill/claude";
import { embed, cosine } from "../src/core/embed";

const TASKS = ["pr description", "commit message", "code review comment", "changelog entry", "release notes", "bug report"];
const SYS = "You write reusable master prompts (the standing instructions an agent follows every time) for a task type. You never produce an example of the task itself.";
const userPrompt = (task: string) => `Write the reusable MASTER PROMPT for this task type as short bullet-line instructions (one instruction per line). Do NOT produce an example of the task.\n\nTask type: ${task}\n\nOutput only the master prompt.`;

console.log("generating master prompts (live)...");
const masters: Record<string, string> = {};
for (const t of TASKS) { masters[t] = (await runClaude(userPrompt(t), { system: SYS })).text; }

// split a master into atomic instruction lines
const toLines = (md: string) => md.split("\n").map((s) => s.replace(/^[-*\d.)#>\s]+/, "").trim()).filter((s) => s.length >= 12 && /[a-z]/i.test(s));
const items: { task: string; line: string; vec: number[] }[] = [];
for (const t of TASKS) for (const l of toLines(masters[t]!)) items.push({ task: t, line: l, vec: [] });
for (const it of items) it.vec = await embed(it.line);

// greedy clustering: a line joins a cluster if it is >= thresh similar to any member, else starts a new one
function cluster(thresh: number) {
  const cl: { members: number[]; tasks: Set<string> }[] = [];
  for (let i = 0; i < items.length; i++) {
    let best = -1, bestS = thresh;
    for (let c = 0; c < cl.length; c++) {
      let s = -1; for (const m of cl[c]!.members) s = Math.max(s, cosine(items[i]!.vec, items[m]!.vec));
      if (s >= bestS) { bestS = s; best = c; }
    }
    if (best >= 0) { cl[best]!.members.push(i); cl[best]!.tasks.add(items[i]!.task); }
    else cl.push({ members: [i], tasks: new Set([items[i]!.task]) });
  }
  return cl;
}

console.log(`\nper task instruction-line counts:`);
for (const t of TASKS) console.log(`  ${t.padEnd(20)} ${toLines(masters[t]!).length}`);
const flat = items.length;
const chars = items.reduce((s, it) => s + it.line.length, 0);
console.log(`\nFLAT: ${TASKS.length} master prompts, ${flat} total instruction lines, ${chars} chars stored\n`);

for (const thresh of [0.55, 0.7]) {
  const cl = cluster(thresh);
  const shared = cl.filter((c) => c.tasks.size >= 2);
  const sharedChars = cl.reduce((s, c) => s + items[c.members[0]!]!.line.length, 0);
  console.log(`GRAPH @cos>=${thresh}: ${cl.length} distinct patterns (${((1 - cl.length / flat) * 100).toFixed(0)}% fewer than flat), ${sharedChars} chars stored (${((1 - sharedChars / chars) * 100).toFixed(0)}% less), ${shared.length} patterns shared across >= 2 tasks`);
  for (const c of shared.sort((a, b) => b.tasks.size - a.tasks.size).slice(0, 4)) console.log(`   [${[...c.tasks].length} tasks] "${items[c.members[0]!]!.line.slice(0, 64)}"`);
}
