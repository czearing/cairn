// Isolated prototype of the skill pipeline, with KNOWN ground truth so we can measure accuracy.
// No deps. Deterministic PRNG. Stages: compaction table, bottleneck detection, quality attribution
// (ablation), quality metric (jury vs single judge). Run: bun proto-skill.ts
let seed = 20260624;
const rng = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };

// ---- 1. COMPACTION: a finished run -> timestamped table (timestamp, what was done, result) ----
console.log("=== 1. Compacted run (the recipe table) ===");
const run = [
  ["00:00", "research the form: what makes a strong haiku", "5-7-5, seasonal image, a turn"],
  ["00:18", "find inspiration: pick a concrete image", "first frost on a gate"],
  ["00:40", "draft", "draft A: 5-7-5 ok, image flat"],
  ["00:52", "creative pass: sharpen the turn + sensory verb", "draft B: image vivid, turn lands"],
  ["01:05", "grammar/syllable check", "5-7-5 confirmed, 0 errors"],
  ["01:14", "subagent proofread", "approved, 1 word swap"],
];
console.log("  time  | step                                   | result");
for (const [t, w, r] of run) console.log(`  ${t} | ${(w ?? "").padEnd(38)} | ${r}`);

// shared noisy judge: says A>B with logistic prob in the true gap; beta = judge skill.
const judgeAwins = (qa: number, qb: number, beta: number) => rng() < 1 / (1 + Math.exp(-beta * (qa - qb)));
const juryAwins = (qa: number, qb: number, beta: number, N: number) => { let v = 0; for (let i = 0; i < N; i++) v += judgeAwins(qa, qb, beta) ? 1 : 0; return v * 2 > N; };
const mean = (a: number[]) => a.reduce((s, x) => s + x, 0) / a.length;

// ---- 2. BOTTLENECK DETECTION: find the step that ate the time ----
// Each run has K steps with base durations + noise; one random step is the injected bottleneck
// (repeated R times). Detector flags the step with the most total time. Accuracy = matches injected.
function bottleneckAccuracy(noise: number, M = 4000): number {
  const K = 6; let hit = 0;
  for (let m = 0; m < M; m++) {
    const base = Array.from({ length: K }, () => 1 + rng() * 3);       // 1-4 units each
    const inj = Math.floor(rng() * K), R = 4 + Math.floor(rng() * 6);  // injected bottleneck repeats 4-9x
    const total = base.map((b, i) => (i === inj ? b * R : b) * (1 + (rng() * 2 - 1) * noise));
    const flagged = total.indexOf(Math.max(...total));
    if (flagged === inj) hit++;
  }
  return hit / M;
}
console.log("\n=== 2. Bottleneck detection accuracy (flag the time-eating step) ===");
for (const nz of [0.0, 0.3, 0.6]) console.log(`  duration noise +-${(nz * 100) | 0}%:  ${(bottleneckAccuracy(nz) * 100).toFixed(1)}%`);

// ---- 3. QUALITY ATTRIBUTION via ablation: which step CREATES the quality? ----
// Recipe steps have hidden contributions: creative big, redundant zero, others small. full quality =
// sum(contrib). Ablate a step -> quality drops by its contribution. Judge compares full vs ablated T
// times; the step's "essentiality" = win-rate of full. Correct if argmax==creative and argmin==redundant.
function attributionAccuracy(beta: number, T: number, M = 3000) {
  let both = 0, topOnly = 0;
  const contrib = [0.40, 0.20, 0.15, 0.05, 0.0]; // [creative, inspiration, structure, grammar, redundant]
  const CREATIVE = 0, REDUNDANT = 4;
  for (let m = 0; m < M; m++) {
    const c = contrib.map((x) => Math.max(0, x + (rng() * 2 - 1) * 0.03)); // small per-run variation
    const full = c.reduce((s, x) => s + x, 0);
    const winrate = c.map((ci) => { let w = 0; for (let t = 0; t < T; t++) w += judgeAwins(full, full - ci, beta) ? 1 : 0; return w / T; });
    const top = winrate.indexOf(Math.max(...winrate)), bot = winrate.indexOf(Math.min(...winrate));
    if (top === CREATIVE) topOnly++;
    if (top === CREATIVE && bot === REDUNDANT) both++;
  }
  return { top: topOnly / M, both: both / M };
}
console.log("\n=== 3. Quality attribution accuracy (ablation finds the quality driver) ===");
console.log("  judge skill | trials/step | finds creative=top | + finds redundant=cuttable");
for (const beta of [4, 8, 16]) for (const T of [3, 7]) {
  const r = attributionAccuracy(beta, T);
  const acc = `~${(50 + 50 * Math.tanh(beta * 0.1)).toFixed(0)}%@gap.1`;
  console.log(`  beta ${beta} (${acc}) |     ${T}       |      ${(r.top * 100).toFixed(1)}%        |       ${(r.both * 100).toFixed(1)}%`);
}

// ---- 4. QUALITY METRIC reliability: single judge vs jury at picking the better output ----
function pickBetterAccuracy(beta: number, N: number, M = 20000): number {
  let hit = 0;
  for (let m = 0; m < M; m++) {
    const qa = rng(), qb = rng(); if (Math.abs(qa - qb) < 0.05) { m--; continue; } // skip near-ties
    const said = juryAwins(qa, qb, beta, N);
    if (said === qa > qb) hit++;
  }
  return hit / M;
}
console.log("\n=== 4. Quality metric reliability (pick the better output) ===");
console.log("  judge skill | single | jury-3 | jury-5 | jury-7");
for (const beta of [3, 6, 12]) {
  console.log(`  beta ${String(beta).padStart(2)}      |  ${(pickBetterAccuracy(beta, 1) * 100).toFixed(1)}% | ${(pickBetterAccuracy(beta, 3) * 100).toFixed(1)}% | ${(pickBetterAccuracy(beta, 5) * 100).toFixed(1)}% | ${(pickBetterAccuracy(beta, 7) * 100).toFixed(1)}%`);
}
