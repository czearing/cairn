import { test, expect, beforeEach } from "bun:test";
import { rerank, reinforce, getStat } from "../src/core/cases";
import { db } from "../src/core/db";

// Each test starts from a clean outcome record (the two tests reuse the same case ids).
beforeEach(() => { try { db().run("DELETE FROM case_stats"); } catch { /* table not created yet */ } });

// Recurring trivial task: "write a haiku". Three saved approaches:
//   full   research-what-a-haiku-is -> creative -> inspiration -> write -> count syllables (6 steps, works)
//   lean   creative -> inspiration -> write -> count syllables          (4 steps, works; research now redundant)
//   skip   write -> count syllables                                     (2 steps, MOST similar, but skips the
//                                                                         creative process => critical failure)
// Quality gate: a haiku is only good if the creative process happened. Right syllable count alone is NOT
// enough. So skip fails the gate even though it is the shortest and the most similar.
const NOW = 1_700_000_000_000;
const P = {
  full: { id: "h-full", steps: 6, score: 0.90, creative: true },
  lean: { id: "h-lean", steps: 4, score: 0.88, creative: true },
  skip: { id: "h-skip", steps: 2, score: 0.99, creative: false },
};
const procs = [P.skip, P.full, P.lean];
const byId = new Map(procs.map((p) => [p.id, p]));
const quality = (p: { creative: boolean }) => p.creative; // the "do not cut the essential step" oracle

test("ranking: quality strictly beats the shortcut; the leaner VALID path wins", () => {
  for (let i = 0; i < 10; i++) { reinforce(P.skip.id, false, 2, NOW); reinforce(P.full.id, true, 6, NOW); reinforce(P.lean.id, true, 4, NOW); }
  const out = rerank(procs.map((p) => ({ id: p.id, score: p.score })), NOW);
  expect(out[out.length - 1]!.id).toBe(P.skip.id); // the fewest-steps, most-similar shortcut is rejected to the bottom
  expect(out[0]!.id).toBe(P.lean.id);              // among the working paths, the leaner one is served
});

test("loop: the task gets leaner over reps, and never settles on the step-cutting shortcut", () => {
  const leastUsed = () => procs.map((p) => ({ id: p.id, u: getStat(p.id)?.uses ?? 0 })).sort((a, b) => a.u - b.u)[0]!.id;
  const served: string[] = [], exploit: string[] = []; // exploit = the case served AS BEST (the real signal)
  for (let rep = 0; rep < 60; rep++) {
    const explore = rep % 3 === 0;
    const id = explore ? leastUsed() : rerank(procs.map((p) => ({ id: p.id, score: p.score })), NOW)[0]!.id;
    reinforce(id, quality(byId.get(id)!), byId.get(id)!.steps, NOW);
    served.push(id);
    if (!explore) exploit.push(id);
  }
  const count = (a: string[], v: string) => a.filter((x) => x === v).length;
  const mode = (a: string[]) => [...new Set(a)].reduce((b, v) => (count(a, v) > count(a, b) ? v : b), a[0]!);

  expect(mode(served.slice(-15))).toBe(P.lean.id);                // converged to the leaner VALID path
  expect(byId.get(mode(served.slice(-15)))!.creative).toBe(true); // the winner kept the essential step
  // growth: the best-served path moved from the full researched path to the lean one (6 steps -> 4)
  expect(exploit[0]).toBe(P.full.id);                            // first best choice, before the lean path had data
  expect(exploit.at(-1)).toBe(P.lean.id);                        // last best choice is the lean path
  expect(P.full.steps).toBeGreaterThan(P.lean.steps);            // ...which is genuinely fewer steps
  expect(count(served.slice(-15), P.skip.id)).toBeLessThanOrEqual(5); // shortcut never dominates
  const s = getStat(P.skip.id)!;
  expect(s.wins / (s.wins + s.losses)).toBeLessThan(0.2);        // shortcut proven to fail the gate
});
