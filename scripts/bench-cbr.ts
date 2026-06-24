// A/B benchmark: outcome-ranked retrieval (CBR) vs the cosine-only baseline (cairn today), across a
// population of recurring tasks. Isolated: uses a TEMP db, never the real brain. The headline question:
// how much does serving the case that WORKED beat serving the case that just LOOKS most similar?
//
// Each task has K candidate cases with a hidden true success rate. Similarity is a NOISY signal of that
// rate (sigma = how misleading similarity is). Baseline serves argmax(similarity) forever. CBR serves
// argmax(rerank) and learns from outcomes. Oracle always serves the truly-best case (the ceiling).
// Run: bun scripts/bench-cbr.ts
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

process.env.CAIRN_DB_PATH = join(tmpdir(), `cbr-bench-${randomUUID()}.db`);
const { rerank, reinforce, getStat } = await import("../src/core/cases");
const { db } = await import("../src/core/db");

let seed = 987654321;
const rng = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

const T = 300, K = 4, R = 40, WINDOW = 10; // tasks, candidates/task, reps/task, late window measured

type Cand = { id: string; trueSucc: number; steps: number; sim: number };
function buildTask(t: number, sigma: number): Cand[] {
  const cs: Cand[] = [];
  for (let c = 0; c < K; c++) {
    const trueSucc = c === 0 ? 0.85 + rng() * 0.10 : 0.20 + rng() * 0.50; // one strong, rest weaker
    const steps = 2 + Math.floor(rng() * 7);
    // sigma >= 1 models similarity INDEPENDENT of success (cairn's real case: question-text similarity
    // says little about which approach actually worked). Else similarity = success + bounded noise.
    const sim = sigma >= 1 ? rng() : clamp01(trueSucc + (rng() * 2 - 1) * sigma);
    cs.push({ id: `t${t}-c${c}`, trueSucc, steps, sim });
  }
  return cs;
}

function runSigma(sigma: number) {
  db().run("CREATE TABLE IF NOT EXISTS case_stats (id TEXT PRIMARY KEY, uses INTEGER NOT NULL DEFAULT 0, wins INTEGER NOT NULL DEFAULT 0, losses INTEGER NOT NULL DEFAULT 0, steps INTEGER NOT NULL DEFAULT 0, last_used INTEGER NOT NULL DEFAULT 0)");
  db().run("DELETE FROM case_stats");
  let bS = 0, bSt = 0, oS = 0, oSt = 0, cS = 0, cSt = 0, n = 0, cN = 0;
  for (let t = 0; t < T; t++) {
    const cs = buildTask(t, sigma);
    const baseline = cs.reduce((a, b) => (b.sim > a.sim ? b : a));         // cosine pick (fixed, never learns)
    const oracle = cs.reduce((a, b) => (b.trueSucc > a.trueSucc ? b : a)); // ceiling
    bS += baseline.trueSucc; bSt += baseline.steps; oS += oracle.trueSucc; oSt += oracle.steps; n++;
    const NOW = 1_700_000_000_000 + t * 1000;
    // Learning phase: serve, observe an outcome, reinforce. Exploration is part of LEARNING, not scored.
    for (let rep = 0; rep < R; rep++) {
      const explore = rep < K || rep % 5 === 0;
      const id = explore
        ? cs.map((c) => ({ id: c.id, u: getStat(c.id)?.uses ?? 0 })).sort((a, b) => a.u - b.u)[0]!.id
        : rerank(cs.map((c) => ({ id: c.id, score: c.sim })), NOW)[0]!.id;
      const c = cs.find((x) => x.id === id)!;
      reinforce(id, rng() < c.trueSucc, c.steps, NOW);
    }
    // Eval: what CBR serves in production AFTER learning (pure exploit) vs baseline's fixed cosine pick.
    const pick = cs.find((x) => x.id === rerank(cs.map((c) => ({ id: c.id, score: c.sim })), NOW)[0]!.id)!;
    cS += pick.trueSucc; cSt += pick.steps; cN++;
  }
  return { sigma, bS: bS / n, bSt: bSt / n, oS: oS / n, oSt: oSt / n, cS: cS / cN, cSt: cSt / cN };
}

const f = (x: number) => x.toFixed(3);
console.log(`tasks=${T} candidates/task=${K} reps/task=${R}  (success = expected true success of the SERVED case)\n`);
console.log("sim noise | baseline | CBR   | oracle | LIFT (CBR-base) | base steps | CBR steps | oracle steps");
console.log("-".repeat(94));
for (const sigma of [0.0, 0.2, 0.4, 0.6, 1.0]) {
  const r = runSigma(sigma);
  const label = sigma >= 1 ? " indep " : `  ${sigma.toFixed(1)}  `;
  console.log(`${label} |  ${f(r.bS)}  | ${f(r.cS)} | ${f(r.oS)}  |     +${f(r.cS - r.bS)}      |   ${f(r.bSt)}    |   ${f(r.cSt)}   |   ${f(r.oSt)}`);
}
console.log("\nnoise 0 = similarity perfectly tracks success (CBR adds nothing, honest). As similarity stops");
console.log("predicting success, baseline collapses toward an average case while CBR stays near the oracle.");
console.log("'indep' = similarity independent of success, the realistic case for a memory of approaches.");
