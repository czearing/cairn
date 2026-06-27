import { test, expect, beforeEach } from "bun:test";
import { rmSync, mkdirSync } from "node:fs";
import { registerInflight, markReady, claimReviewFlag, lockHolder, readyRuns, WAIT_MS, type ReadyRun } from "../src/skill/coordinate";
import { coordinatedReview } from "../src/skill/coordinator";

const DIR = process.env.CAIRN_INFLIGHT_DIR!;
beforeEach(() => { try { rmSync(DIR, { recursive: true, force: true }); } catch { /* none */ } mkdirSync(DIR, { recursive: true }); });

const T = 2_000_000;
function clock(start: number) {
  let t = start;
  return { now: () => t, sleep: async (ms: number) => { t += ms; } };
}

test("three concurrent same-skill runs coalesce into ONE review of all three", async () => {
  // A finishes first while B and C are still in flight; they finish during A's wait, so A reviews all three.
  for (const s of ["A", "B", "C"]) registerInflight(s, "haiku", T);
  const seen: ReadyRun[][] = [];
  const c = clock(T);
  const sleep = async (ms: number) => {
    markReady("B", "haiku", "out B", "tx B", c.now()); // B and C finish during A's first poll
    markReady("C", "haiku", "out C", "tx C", c.now());
    await c.sleep(ms);
  };
  const r = await coordinatedReview("A", "haiku", "out A", "tx A", { review: async (runs) => { seen.push(runs); }, now: c.now, sleep });

  expect(r).toEqual({ reviewed: true, count: 3, reason: "reviewed" });
  expect(seen.length).toBe(1);                                   // exactly one review ran
  expect(seen[0]!.map((x) => x.session).sort()).toEqual(["A", "B", "C"]); // it saw all three
  expect(lockHolder("haiku")).toBeNull();                        // lock released
  expect(readyRuns("haiku", c.now())).toEqual([]);               // coalesced set cleared
});

test("a finisher waits for a sibling still working, then reviews both when it finishes", async () => {
  registerInflight("A", "haiku", T);
  registerInflight("B", "haiku", T);         // B is still 'doing'
  let polls = 0;
  const c = clock(T);
  const sleep = async (ms: number) => { polls++; if (polls === 2) markReady("B", "haiku", "out B", "tx B", c.now()); await c.sleep(ms); };
  const seen: ReadyRun[][] = [];
  const r = await coordinatedReview("A", "haiku", "out A", "tx A", { review: async (runs) => { seen.push(runs); }, now: c.now, sleep });
  expect(r).toEqual({ reviewed: true, count: 2, reason: "reviewed" });   // waited for B, then reviewed A+B
  expect(seen[0]!.map((x) => x.session).sort()).toEqual(["A", "B"]);
});

test("a finisher reviews alone after the wait window if a sibling never finishes", async () => {
  registerInflight("A", "haiku", T);
  registerInflight("Bstuck", "haiku", T);    // never marked ready
  const c = clock(T);
  const seen: ReadyRun[][] = [];
  const r = await coordinatedReview("A", "haiku", "out A", "tx A", { review: async (runs) => { seen.push(runs); }, now: c.now, sleep: c.sleep, pollMs: WAIT_MS });
  expect(r).toEqual({ reviewed: true, count: 1, reason: "reviewed" }); // timed out, reviewed itself alone
  expect(seen[0]!.map((x) => x.session)).toEqual(["A"]);
});

test("a session whose peer holds the review lock does not double-review", async () => {
  registerInflight("A", "haiku", T);
  claimReviewFlag("haiku", "Other", T);      // a peer is already reviewing and holds the lock
  const c = clock(T);
  let ran = false;
  const r = await coordinatedReview("A", "haiku", "out A", "tx A", { review: async () => { ran = true; }, now: c.now, sleep: c.sleep, pollMs: WAIT_MS });
  expect(r.reviewed).toBe(false);
  expect(ran).toBe(false);                   // never ran its own review
  expect(lockHolder("haiku")).toBe("Other"); // did not steal the peer's lock
});
