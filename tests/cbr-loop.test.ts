import { test, expect } from "bun:test";
import { rerank, reinforce, getStat } from "../src/core/cases";

// Closed-loop effectiveness test. The whole point of CBR: serve the top case, observe the outcome,
// reinforce, repeat — and the system must LEARN to serve the effective case and improve results, with
// NO oracle peeking (it only sees pass/fail after serving). Deterministic, no randomness.
const NOW = 1_700_000_000_000;
const GOOD = "loop-good", BAD = "loop-bad";

// BAD is MORE relevant (higher cosine), so pure similarity would keep serving it forever.
const candidates = () => [{ id: BAD, score: 0.94 }, { id: GOOD, score: 0.90 }];
// Hidden truth the loop must discover: GOOD succeeds ~90% in 5 steps, BAD ~30% in 12.
const oracle = (id: string, rep: number) => (id === GOOD ? rep % 10 !== 0 : rep % 10 < 3);

test("closed loop converges to the effective case and improves outcomes", () => {
  const served: string[] = [], success: boolean[] = [];
  for (let rep = 0; rep < 40; rep++) {
    const top = rerank(candidates(), NOW)[0]!.id;          // serve top by current effectiveness
    const ok = oracle(top, rep);                            // observe outcome (no peeking before serving)
    reinforce(top, ok, top === GOOD ? 5 : 12, NOW);        // learn
    served.push(top); success.push(ok);
  }
  const last10Good = served.slice(-10).filter((x) => x === GOOD).length;
  const firstSucc = success.slice(0, 10).filter(Boolean).length;
  const lastSucc = success.slice(-10).filter(Boolean).length;

  expect(last10Good).toBeGreaterThanOrEqual(9);   // it learned to serve GOOD (despite BAD being more similar)
  expect(lastSucc).toBeGreaterThan(firstSucc);    // served outcomes improved over the run
  // and the discovered records reflect the hidden truth
  expect(getStat(GOOD)!.wins / (getStat(GOOD)!.wins + getStat(GOOD)!.losses)).toBeGreaterThan(0.8);
});

test("a self-correcting check: with the OLD use-frequency scoring BAD would never be dethroned", () => {
  // baseLevel over use COUNT = ln(1+uses): after BAD is served k times its (1+baseLevel) multiplier is
  // ~1+ln(1+k), which swamps a 0.3 vs 0.5 success gap. This asserts the FIX (success-dominated score):
  // a heavily-used low-success case must score BELOW a fresh neutral one.
  const heavyBad = "hb-" + NOW;
  for (let i = 0; i < 20; i++) reinforce(heavyBad, i % 10 < 3, 12, NOW); // 20 uses, ~30% success
  const out = rerank([{ id: heavyBad, score: 0.99 }, { id: "fresh-" + NOW, score: 0.5 }], NOW);
  expect(out[0]!.id).toBe("fresh-" + NOW); // proven-bad loses to unknown; frequency does not rescue it
});
