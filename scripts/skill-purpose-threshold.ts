#!/usr/bin/env bun
// Calibrate PURPOSE_THRESHOLD for the reuse guard, using the REQUEST as the signal (the master shares too much
// instructional boilerplate to separate). The guard reuses a skill when cosine(run request, frozen identity
// request) >= threshold, so the threshold must sit ABOVE the cross-domain cluster and BELOW the same-domain
// cluster. We lean LOOSE (low end of the gap) so a real same-task request is never wrongly forked; the only
// thing we must reliably catch is a clearly different domain (audio A/B wearing a "pr monitor" label).
import { embed, cosine } from "../src/core/embed";

// Representative real requests per domain (2-3 each). within-domain pairs should be HIGH, cross LOW.
const domains: Record<string, string[]> = {
  "audio ab": [
    "A/B the forest track with the selected reference",
    "render Forest with the Eusexua reference and compare LUFS and true peak",
    "master this track against two references and tell me which is louder",
  ],
  "pr monitor": [
    "monitor my Azure PR and ping me when the builds pass",
    "watch PR 12345, requeue flaky builds, and tell me when it is ready to merge",
    "keep an eye on the pull request build policies and merge status",
  ],
  "haiku": [
    "write me a haiku about frost",
    "compose a haiku about the sea at dawn",
  ],
  "short story": [
    "write a short story about a lighthouse keeper",
    "draft a short story set in a failing trade",
  ],
  "codebase explainer": [
    "explain how the skill loop works in this repo",
    "walk me through how retrieval matches a query to a skill",
  ],
  "commit message": [
    "write a commit message for this diff",
    "draft a conventional commit for the bug fix",
  ],
};

const names = Object.keys(domains);
const vecs: Record<string, number[][]> = {};
for (const d of names) vecs[d] = await Promise.all(domains[d]!.map((r) => embed(r)));

const within: number[] = [], cross: number[] = [];
for (const d of names) {
  const vs = vecs[d]!;
  for (let i = 0; i < vs.length; i++) for (let j = i + 1; j < vs.length; j++) within.push(cosine(vs[i]!, vs[j]!));
}
const crossPairs: { a: string; b: string; c: number }[] = [];
for (let i = 0; i < names.length; i++) for (let j = i + 1; j < names.length; j++) {
  let best = -1;
  for (const va of vecs[names[i]!]!) for (const vb of vecs[names[j]!]!) best = Math.max(best, cosine(va, vb));
  crossPairs.push({ a: names[i]!, b: names[j]!, c: best }); // worst case per domain pair = the MAX cross cosine
  for (const va of vecs[names[i]!]!) for (const vb of vecs[names[j]!]!) cross.push(cosine(va, vb));
}

const stats = (xs: number[]) => ({ min: Math.min(...xs), max: Math.max(...xs), mean: xs.reduce((a, b) => a + b, 0) / xs.length });
const f = (n: number) => n.toFixed(3);
const w = stats(within), c = stats(cross);
const audioVsPr = crossPairs.find((p) => (p.a === "audio ab" && p.b === "pr monitor") || (p.a === "pr monitor" && p.b === "audio ab"))!.c;

console.log(`WITHIN-domain (same task):  min ${f(w.min)}  mean ${f(w.mean)}  max ${f(w.max)}  n=${within.length}`);
console.log(`CROSS-domain (diff task):   min ${f(c.min)}  mean ${f(c.mean)}  max ${f(c.max)}  n=${cross.length}`);
console.log(`audio-ab vs pr-monitor (the case the guard MUST block), worst-case pair cosine: ${f(audioVsPr)}`);
console.log(`\nworst-case (MAX) cross cosine per domain pair:`);
for (const p of crossPairs.sort((x, y) => y.c - x.c)) console.log(`  ${f(p.c)}  ${p.a}  vs  ${p.b}`);

// Lean loose: threshold just UNDER the within-domain floor, so a real same-task request never forks. It must
// also stay above the audio-vs-pr clobber so that case is still caught; the two only fit if floor > that case.
const recommended = w.min - 0.03;
console.log(`\nwithin-domain floor ${f(w.min)} ; cross worst ${f(Math.max(...crossPairs.map((p) => p.c)))}`);
console.log(`recommended PURPOSE_THRESHOLD (loose, floor - 0.03): ${f(recommended)}`);
console.log(`  must-catch audio->pr (${f(audioVsPr)}) below it? ${audioVsPr < recommended ? "YES" : "NO (window too tight; need a stronger signal)"}`);
process.exit(0);
