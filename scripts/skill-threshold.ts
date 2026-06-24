// Calibrate SKILL_THRESHOLD from real MiniLM embeddings: same-type tasks (re-phrasings of one skill)
// must score ABOVE it, different-type tasks BELOW it. Prints the within-group vs cross-group cosines and
// the widest separating threshold. Run: bun scripts/skill-threshold.ts
import { embed, cosine } from "../src/core/embed";

// Calibrate on canonical task LABELS (the form, topic stripped), since that is what categorize keys on.
// within-group = phrasings of the same label (must match); cross-group = different labels, incl. the hard
// poem-vs-haiku pair (must stay separate).
const GROUPS: Record<string, string[]> = {
  haiku: ["haiku", "write a haiku", "compose a haiku", "haiku poem"],
  poem: ["poem", "write a poem", "free verse poem", "compose a poem"],
  sonnet: ["sonnet", "write a sonnet", "compose a sonnet"],
  commit: ["commit message", "write a commit message", "git commit message"],
  sql: ["sql query", "write a sql query", "sql select statement"],
};

const vecs: Record<string, number[][]> = {};
for (const [g, items] of Object.entries(GROUPS)) vecs[g] = await Promise.all(items.map(embed));

const within: number[] = [], cross: number[] = [];
const keys = Object.keys(GROUPS);
for (const g of keys) {
  const vs = vecs[g]!;
  for (let i = 0; i < vs.length; i++) for (let j = i + 1; j < vs.length; j++) within.push(cosine(vs[i]!, vs[j]!));
}
for (let a = 0; a < keys.length; a++) for (let b = a + 1; b < keys.length; b++)
  for (const x of vecs[keys[a]!]!) for (const y of vecs[keys[b]!]!) cross.push(cosine(x, y));

const stats = (xs: number[]) => ({ min: Math.min(...xs), max: Math.max(...xs), mean: xs.reduce((s, x) => s + x, 0) / xs.length });
const w = stats(within), c = stats(cross);
const fmt = (n: number) => n.toFixed(3);
console.log(`within-group (same skill):   min ${fmt(w.min)}  mean ${fmt(w.mean)}  max ${fmt(w.max)}`);
console.log(`cross-group (diff skills):   min ${fmt(c.min)}  mean ${fmt(c.mean)}  max ${fmt(c.max)}`);
console.log(`separation: lowest same-type ${fmt(w.min)} vs highest diff-type ${fmt(c.max)}`);
const mid = (w.min + c.max) / 2;
console.log(`clean split possible: ${w.min > c.max ? "YES, threshold ~" + fmt(mid) : "NO (overlap) — pick by tolerance"}`);
