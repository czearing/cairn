// Transfer + learning curve: does a POEM skill seed a HAIKU task and reach quality faster, and is the
// transfer SMART (drops a poem-specific step that hurts haiku)? Quality is the objective (95/5), so the
// optimizer only ever removes ZERO or NEGATIVE value steps, never a positive one.
let seed = 11; const rng = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
const mean = (a: number[]) => a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0;
const judgeAwins = (qa: number, qb: number, beta: number) => rng() < 1 / (1 + Math.exp(-beta * (qa - qb)));
const juryAwins = (qa: number, qb: number, beta: number, N: number) => { let v = 0; for (let i = 0; i < N; i++) v += judgeAwins(qa, qb, beta) ? 1 : 0; return v * 2 > N; };

// HAIKU task ground truth. Shared steps transfer from poem; freeform is poem-specific and HURTS haiku;
// syllable_575 is haiku-specific. essentials must be present or quality is penalized.
const STEP = ["creative","inspiration","imagery","freeform","syllable_575","redundant"];
const Q =    [ 0.40,      0.20,         0.15,     -0.10,      0.35,          0.00 ]; // value FOR HAIKU
const ESS =  [ true,      true,         false,    false,      true,          false];
const POEM_SKILL = ["creative","inspiration","imagery","freeform"];                 // what transfers in
const OPT = ["creative","inspiration","imagery","syllable_575"];
const idx = (n: string) => STEP.indexOf(n);
const quality = (keep: boolean[]) => { let q = 0, miss = 0; for (let i = 0; i < STEP.length; i++) { if (keep[i]) q += Q[i]!; else if (ESS[i]) miss++; } return q - 0.30 * miss; };
const OPTQ = quality(STEP.map((s) => OPT.includes(s)));

// value of step i in current recipe = jury win-rate of (with i) vs (without i). >0.5 helps, ~0.5 neutral, <0.5 hurts.
function value(keep: boolean[], i: number, beta: number, jury: number, votes: number) {
  const a = keep.slice(); a[i] = true; const b = keep.slice(); b[i] = false;
  let w = 0; for (let v = 0; v < votes; v++) w += juryAwins(quality(a), quality(b), beta, jury) ? 1 : 0; return w / votes;
}
// One optimization round: ablation-test every step in the recipe, DROP only clearly non-positive ones
// (<=0.5 band, quality-protective), and try ONE new candidate from the pool, keeping it if it helps.
function round(keep: boolean[], pool: number[], beta: number, jury: number, votes: number) {
  for (let i = 0; i < STEP.length; i++) if (keep[i] && value(keep, i, beta, jury, votes) < 0.45) keep[i] = false; // drop only harmful/zero
  if (pool.length) { const c = pool.shift()!; keep[c] = true; if (value(keep, c, beta, jury, votes) < 0.55) keep[c] = false; }
  return keep;
}
function trajectory(warm: boolean, beta = 8, jury = 5, votes = 7, ROUNDS = 5) {
  const keep = new Array(STEP.length).fill(false);
  let pool: number[];
  if (warm) { for (const s of POEM_SKILL) keep[idx(s)] = true; pool = ["syllable_575","redundant"].map(idx); } // seeded from poem
  else { pool = STEP.map((_, i) => i); pool.sort(() => rng() - 0.5); }                                          // cold: discover all
  const traj: number[] = [];
  for (let r = 0; r < ROUNDS; r++) { round(keep, pool, beta, jury, votes); traj.push(quality(keep)); }
  return { traj, keep };
}

console.log(`HAIKU optimal recipe = ${OPT.join(", ")}  quality=${OPTQ.toFixed(2)}`);
console.log("transfer in = poem skill [creative, inspiration, imagery, freeform]  (freeform HURTS haiku, q=-0.10)\n");

function avgTraj(warm: boolean, M = 3000, ROUNDS = 5) {
  const sum = new Array(ROUNDS).fill(0); let dropFreeform = 0, addSyll = 0, hitOpt = 0;
  for (let m = 0; m < M; m++) { const { traj, keep } = trajectory(warm, 8, 5, 7, ROUNDS); traj.forEach((q, r) => sum[r] += q); if (!keep[idx("freeform")]) dropFreeform++; if (keep[idx("syllable_575")]) addSyll++; if (STEP.every((s, i) => keep[i] === OPT.includes(s))) hitOpt++; }
  return { traj: sum.map((x) => x / M), dropFreeform: dropFreeform / M, addSyll: addSyll / M, hitOpt: hitOpt / M };
}
const cold = avgTraj(false), warm = avgTraj(true);
console.log("=== quality per round (mean over 3000 fleets) ===");
console.log("  round         1     2     3     4     5");
console.log(`  cold start  ${cold.traj.map((q) => q.toFixed(2)).join("  ")}`);
console.log(`  warm (xfer) ${warm.traj.map((q) => q.toFixed(2)).join("  ")}`);
console.log(`\n  round-1 quality: warm ${warm.traj[0]!.toFixed(2)} vs cold ${cold.traj[0]!.toFixed(2)}  (lift +${(warm.traj[0]!-cold.traj[0]!).toFixed(2)})`);
console.log(`  reached optimal recipe by round 5: warm ${(warm.hitOpt*100).toFixed(1)}% | cold ${(cold.hitOpt*100).toFixed(1)}%`);
console.log(`  transfer is SMART: dropped the harmful poem step (freeform) ${(warm.dropFreeform*100).toFixed(1)}% | added haiku-specific 5-7-5 ${(warm.addSyll*100).toFixed(1)}%`);
