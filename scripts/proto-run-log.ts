// Run log + "look at the top-N prior runs to spot steps that had an effect". A run records its recipe,
// per-step times, and quality. On a new run we pull the top-K by quality and diff recipes: a step that
// is over-represented in the best runs is a candidate quality driver; high mean time => bottleneck.
let seed = 3; const rng = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
const gauss = () => Math.sqrt(-2 * Math.log(rng() + 1e-9)) * Math.cos(6.283 * rng());
const mean = (a: number[]) => a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0;

const NAME = ["creative","inspiration","structure","grammar","redundant"];
const Q =    [ 0.40,      0.20,         0.15,       0.05,      0.00 ]; // true quality effect (ground truth)
const T =    [ 8,         5,            4,          2,         9    ]; // time cost; redundant is the bottleneck
const K = NAME.length;

type Run = { recipe: boolean[]; q: number; times: number[] };
function makeRuns(M: number): Run[] {
  const out: Run[] = [];
  for (let m = 0; m < M; m++) {
    const recipe = NAME.map(() => rng() < 0.5);
    let q = 0; for (let i = 0; i < K; i++) if (recipe[i]) q += Q[i]!;
    q += gauss() * 0.05; // observation noise on the quality measurement
    const times = recipe.map((on, i) => (on ? T[i]! * (1 + gauss() * 0.15) : 0));
    out.push({ recipe, q, times });
  }
  return out;
}
// SCREEN: presence-rate of each step in the top-K runs minus its rate in the bottom-K. High score = the
// step shows up in the best runs and not the worst => a candidate quality driver to confirm by ablation.
function screen(runs: Run[], topK: number): number[] {
  const sorted = [...runs].sort((a, b) => b.q - a.q);
  const top = sorted.slice(0, topK), bot = sorted.slice(-topK);
  return NAME.map((_, i) => mean(top.map((r) => (r.recipe[i] ? 1 : 0))) - mean(bot.map((r) => (r.recipe[i] ? 1 : 0))));
}
const bottleneck = (runs: Run[]) => { const tot = NAME.map((_, i) => runs.reduce((s, r) => s + r.times[i]!, 0)); return tot.indexOf(Math.max(...tot)); };

console.log("ground truth quality order: creative > inspiration > structure > grammar > redundant(0)");
console.log("ground truth bottleneck (most total time): redundant\n");

// accuracy of the screen vs how many prior runs you keep (M) and how many top/bottom you compare (topK)
function fleetAcc(M: number, topK: number, F = 4000) {
  let top1 = 0, bot1 = 0, bottleneckHit = 0;
  for (let f = 0; f < F; f++) {
    const runs = makeRuns(M);
    const sc = screen(runs, Math.min(topK, M >> 1));
    if (sc.indexOf(Math.max(...sc)) === 0) top1++;          // creative ranked the top driver
    if (sc.indexOf(Math.min(...sc)) === 4) bot1++;          // redundant ranked the non-driver
    if (bottleneck(runs) === 4) bottleneckHit++;            // redundant flagged as the time sink
  }
  return { top1: top1 / F, bot1: bot1 / F, bn: bottleneckHit / F };
}
console.log("=== screen accuracy: keep M prior runs, compare top-K vs bottom-K ===");
console.log("  prior runs (M) | top-K | finds creative=driver | finds redundant=non-driver | bottleneck found");
for (const [M, topK] of [[20,5],[50,10],[100,10],[200,20]] as const) {
  const a = fleetAcc(M, topK);
  console.log(`      ${String(M).padStart(3)}        |  ${String(topK).padStart(2)}   |        ${(a.top1*100).toFixed(1)}%         |          ${(a.bot1*100).toFixed(1)}%           |     ${(a.bn*100).toFixed(1)}%`);
}
console.log("\n  (the screen is a cheap CANDIDATE generator from the run log; confirm the top candidates with ablation.)");
