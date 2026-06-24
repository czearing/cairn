import { test, expect, beforeEach } from "bun:test";
import { rerank, reinforce, getStat } from "../src/core/cases";
import { db } from "../src/core/db";

beforeEach(() => { try { db().run("DELETE FROM case_stats"); } catch { /* table not created yet */ } });

let seed = 42;
const rng = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };

// Locks the headline benchmark claim (full sweep in scripts/bench-cbr.ts): when text similarity does
// NOT predict which approach actually worked (cairn's real case, sim independent of success), serving
// the outcome-ranked case beats serving the most-similar one by a wide margin.
test("benchmark guard: with similarity independent of success, CBR beats the cosine baseline by >0.2", () => {
  const T = 60, K = 4, R = 30;
  let base = 0, cbr = 0;
  for (let t = 0; t < T; t++) {
    const cs = Array.from({ length: K }, (_, c) => ({
      id: `b${t}-${c}`,
      trueSucc: c === 0 ? 0.9 : 0.2 + rng() * 0.5, // one strong approach, rest weaker
      steps: 2 + Math.floor(rng() * 6),
      sim: rng(),                                   // similarity is pure noise w.r.t. success
    }));
    base += cs.reduce((a, b) => (b.sim > a.sim ? b : a)).trueSucc; // cosine serves the most similar
    const NOW = 1_700_000_000_000 + t * 1000;
    for (let rep = 0; rep < R; rep++) {             // CBR learns from outcomes
      const explore = rep < K || rep % 5 === 0;
      const id = explore
        ? cs.map((c) => ({ id: c.id, u: getStat(c.id)?.uses ?? 0 })).sort((a, b) => a.u - b.u)[0]!.id
        : rerank(cs.map((c) => ({ id: c.id, score: c.sim })), NOW)[0]!.id;
      const c = cs.find((x) => x.id === id)!;
      reinforce(id, rng() < c.trueSucc, c.steps, NOW);
    }
    cbr += cs.find((x) => x.id === rerank(cs.map((c) => ({ id: c.id, score: c.sim })), NOW)[0]!.id)!.trueSucc;
  }
  const lift = (cbr - base) / T;
  expect(lift).toBeGreaterThan(0.2);
});
