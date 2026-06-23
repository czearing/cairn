import { test, expect } from "bun:test";
import { reinforce, getStat, successRate, effScore, rerank, type CaseStat } from "../src/core/cases";

const NOW = 1_700_000_000_000;
const stat = (p: Partial<CaseStat>): CaseStat => ({ id: "x", uses: 0, wins: 0, losses: 0, steps: 0, lastUsed: NOW, ...p });

test("reinforce + getStat round-trip; success and failure accumulate", () => {
  const id = "rt-" + NOW;
  reinforce(id, true, 5, NOW);
  reinforce(id, true, 4, NOW);
  reinforce(id, false, 9, NOW);
  const s = getStat(id)!;
  expect(s.uses).toBe(3);
  expect(s.wins).toBe(2);
  expect(s.losses).toBe(1);
  expect(s.steps).toBe(4); // leanest run kept
});

test("successRate uses a Laplace prior (unverified ~0.5)", () => {
  expect(successRate(stat({}))).toBeCloseTo(0.5, 5);
  expect(successRate(stat({ wins: 9, losses: 1 }))).toBeCloseTo(10 / 12, 5);
});

test("effScore ranks a proven lean case above a worse, more-used one", () => {
  const good = stat({ steps: 5, wins: 9, losses: 1, uses: 10 });
  const bad = stat({ steps: 12, wins: 3, losses: 5, uses: 8 });
  expect(effScore(good, NOW, 5)).toBeGreaterThan(effScore(bad, NOW, 5));
});

test("rerank: a MORE relevant but worse case is beaten by a proven one (never drops a result)", () => {
  const good = "good-" + NOW, bad = "bad-" + NOW;
  reinforce(good, true, 5, NOW); for (let i = 0; i < 8; i++) reinforce(good, true, 5, NOW); // ~90%, lean
  reinforce(bad, false, 12, NOW); for (let i = 0; i < 4; i++) reinforce(bad, i < 2, 12, NOW); // worse, long
  // BAD has the higher relevance score, yet rerank must surface GOOD first
  const out = rerank([{ id: bad, score: 0.94 }, { id: good, score: 0.90 }], NOW);
  expect(out[0]!.id).toBe(good);
  expect(out.length).toBe(2); // no result dropped
});

test("rerank: a node with no outcome history is not crashed or dropped (neutral baseline)", () => {
  const out = rerank([{ id: "fresh-a-" + NOW, score: 0.8 }, { id: "fresh-b-" + NOW, score: 0.7 }], NOW);
  expect(out.length).toBe(2);
  expect(out.map((o) => o.score).sort()).toEqual([0.7, 0.8]); // both survive
});

test("growth: a fresh case's effScore rises with each verified reuse", () => {
  const id = "grow-" + NOW;
  let prev = -1;
  for (let rep = 0; rep < 6; rep++) {
    reinforce(id, true, 6, NOW);
    const e = effScore(getStat(id)!, NOW, 6);
    expect(e).toBeGreaterThan(prev);
    prev = e;
  }
});
