// v3: recipe optimization by ACTIVE ablation + greedy backward elimination. Stable, no policy collapse.
let seed = 7; const rng = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
const mean = (a: number[]) => a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0;
const judgeAwins = (qa: number, qb: number, beta: number) => rng() < 1 / (1 + Math.exp(-beta * (qa - qb)));
const juryAwins = (qa: number, qb: number, beta: number, N: number) => { let v = 0; for (let i = 0; i < N; i++) v += judgeAwins(qa, qb, beta) ? 1 : 0; return v * 2 > N; };

type Step = { name: string; q: number; t: number; essential: boolean };
const STEPS: Step[] = [
  { name: "creative",      q: 0.40, t: 8, essential: true  },
  { name: "inspiration",   q: 0.20, t: 5, essential: true  },
  { name: "structure",     q: 0.15, t: 4, essential: true  },
  { name: "grammar",       q: 0.05, t: 2, essential: false },
  { name: "over_research", q: 0.02, t: 7, essential: false },
  { name: "redundant_test",q: 0.00, t: 9, essential: false },
];
const K = STEPS.length;
const OPT = [true, true, true, true, false, false];
const quality = (inc: boolean[]) => { let q = 0, miss = 0; for (let i = 0; i < K; i++) { if (inc[i]) q += STEPS[i]!.q; else if (STEPS[i]!.essential) miss++; } return q - 0.30 * miss; };
const time = (inc: boolean[]) => STEPS.reduce((s, st, i) => s + (inc[i] ? st.t : 0), 0);

// value of step i in recipe `keep`: jury win-rate of (recipe with i) over (recipe without i).
function ablationValue(keep: boolean[], i: number, beta: number, jury: number, votes: number): number {
  const withI = keep.slice(); withI[i] = true; const woI = keep.slice(); woI[i] = false;
  const a = quality(withI), b = quality(woI);
  let w = 0; for (let v = 0; v < votes; v++) w += juryAwins(a, b, beta, jury) ? 1 : 0; return w / votes;
}
// Greedy backward elimination: only HIGH-TIME steps are removal candidates; remove the one whose
// presence does NOT clearly improve quality (value below VAL_KEEP), lowest value first. Repeat.
const TIME_CAND = 6, VAL_KEEP = 0.62;
function selectRecipe(beta: number, jury: number, votes: number) {
  const keep = new Array(K).fill(true);
  for (;;) {
    let rm = -1, rmVal = 1;
    for (let i = 0; i < K; i++) {
      if (!keep[i] || STEPS[i]!.t < TIME_CAND) continue;       // only reconsider costly steps
      const val = ablationValue(keep, i, beta, jury, votes);
      if (val < VAL_KEEP && val < rmVal) { rmVal = val; rm = i; } // costly + does not earn its place
    }
    if (rm < 0) break;
    keep[rm] = false;
  }
  return keep;
}

console.log(`naive (all): time=${time(new Array(K).fill(true))} q=${quality(new Array(K).fill(true)).toFixed(2)} | optimal: time=${time(OPT)} q=${quality(OPT).toFixed(2)}\n`);
console.log("=== A. one run (mid judge beta=8, jury=5, votes=5) ===");
const r = selectRecipe(8, 5, 5);
console.log("  kept:", r.map((k, i) => (k ? STEPS[i]!.name : null)).filter(Boolean).join(", "));
console.log(`  time=${time(r)} q=${quality(r).toFixed(2)}  matches optimal: ${r.every((k, i) => k === OPT[i])}`);

function fleets(beta: number, jury: number, votes: number, M = 4000) {
  let opt = 0, essCut = 0, bothWaste = 0, t = 0;
  for (let m = 0; m < M; m++) { const k = selectRecipe(beta, jury, votes); if (k.every((x, i) => x === OPT[i])) opt++; if (STEPS.some((st, i) => st.essential && !k[i])) essCut++; if (!k[4] && !k[5]) bothWaste++; t += time(k); }
  return { opt: opt / M, essCut: essCut / M, bothWaste: bothWaste / M, avgT: t / M };
}
console.log("\n=== B. reliability across 4000 runs ===");
console.log("  judge   votes | exact-optimal | both waste cut | ESSENTIAL cut (must be 0) | avg time (opt=19)");
for (const [beta, jury, votes] of [[4,5,5],[8,5,5],[8,5,9],[8,7,5],[16,5,5]] as const) {
  const s = fleets(beta, jury, votes);
  console.log(`  b${beta} j${jury} v${votes} |    ${(s.opt*100).toFixed(1)}%    |     ${(s.bothWaste*100).toFixed(1)}%     |        ${(s.essCut*100).toFixed(2)}%          |    ${s.avgT.toFixed(1)}`);
}
console.log("\n=== C. cost: judge calls to optimize one recipe ===");
console.log("  worst case ~ (high-time steps) x votes x jury, removed iteratively; for K=6 (3 costly), votes=5:");
for (const j of [1,3,5]) console.log(`  jury ${j}: ~${3*5*j}-${6*5*j} calls total (one-time per task, not per run)`);

// ---- D2: separate the UNAMBIGUOUS zero-waste (redundant_test, q=0) from the marginal step ----
function fleets2(beta: number, jury: number, votes: number, M = 5000) {
  let zeroCut = 0, margCut = 0, essCut = 0, q = 0, t = 0;
  for (let m = 0; m < M; m++) {
    const k = selectRecipe(beta, jury, votes);
    if (!k[5]) zeroCut++;                               // redundant_test (q=0) removed = true waste cut
    if (!k[4]) margCut++;                               // over_research (q=0.02) removed
    if (STEPS.some((st, i) => st.essential && !k[i])) essCut++;
    q += quality(k); t += time(k);
  }
  return { zeroCut: zeroCut / M, margCut: margCut / M, essCut: essCut / M, q: q / M, t: t / M };
}
console.log("\n=== D2. the honest breakdown (naive: t=35 q=0.82 | optimal-efficient: t=19 q=0.80) ===");
console.log("  judge   | zero-waste cut | marginal(q=.02) cut | essential cut | avg quality | avg time");
for (const [beta, jury, votes] of [[4,5,5],[8,5,5],[16,5,5]] as const) {
  const s = fleets2(beta, jury, votes);
  console.log(`  b${beta} j${jury}  |     ${(s.zeroCut*100).toFixed(1)}%     |       ${(s.margCut*100).toFixed(1)}%        |     ${(s.essCut*100).toFixed(2)}%    |    ${s.q.toFixed(2)}     |   ${s.t.toFixed(1)}`);
}

// ---- E: cost/accuracy curve. More ablation votes => sharper waste detection. Essential-cut must stay 0. ----
function curve(votes: number, beta = 8, jury = 5, M = 5000) {
  let zeroCut = 0, essCut = 0, q = 0, t = 0;
  for (let m = 0; m < M; m++) { const k = selectRecipe(beta, jury, votes); if (!k[5]) zeroCut++; if (STEPS.some((st, i) => st.essential && !k[i])) essCut++; q += quality(k); t += time(k); }
  return { zeroCut: zeroCut / M, essCut: essCut / M, q: q / M, t: t / M, calls: 3 * votes * jury };
}
console.log("\n=== E. cost vs accuracy (beta=8 jury=5; naive t=35, optimal t=19) ===");
console.log("  votes | zero-waste cut | essential cut | avg quality | avg time | ~judge calls (one-time)");
for (const v of [5, 11, 21, 41]) {
  const c = curve(v);
  console.log(`  ${String(v).padStart(3)}   |     ${(c.zeroCut*100).toFixed(1)}%     |     ${(c.essCut*100).toFixed(2)}%    |    ${c.q.toFixed(2)}     |   ${c.t.toFixed(1)}   |   ${c.calls}`);
}
