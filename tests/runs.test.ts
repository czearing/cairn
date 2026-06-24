import { test, expect, beforeEach } from "bun:test";
import { logRun, topRuns, recentRuns } from "../src/core/cases";
import { db } from "../src/core/db";

beforeEach(() => { try { db().run("DELETE FROM runs"); } catch { /* table not created yet */ } });

test("run log: topRuns returns the highest-quality runs first, limited to n", () => {
  for (let i = 0; i < 15; i++) logRun({ task: "haiku", ts: 1000 + i, recipe: ["creative", "draft"], times: { creative: 8, draft: 3 }, quality: i / 15 });
  const top = topRuns("haiku", 10);
  expect(top.length).toBe(10);
  expect(top[0]!.quality).toBeGreaterThan(top[9]!.quality);
  expect(top[0]!.quality).toBeCloseTo(14 / 15, 5);
});

test("run log: recipe and per-step times round-trip, scoped by task", () => {
  logRun({ task: "haiku", ts: 1, recipe: ["creative", "syllable"], times: { creative: 8, syllable: 2 }, quality: 0.9 });
  logRun({ task: "poem", ts: 2, recipe: ["freeform"], times: { freeform: 4 }, quality: 0.5 });
  const h = topRuns("haiku", 5);
  expect(h.length).toBe(1);                       // only the haiku run, not the poem
  expect(h[0]!.recipe).toEqual(["creative", "syllable"]);
  expect(h[0]!.times.creative).toBe(8);
});

test("run log: recentRuns orders by timestamp", () => {
  logRun({ task: "t", ts: 5, recipe: [], times: {}, quality: 0.1 });
  logRun({ task: "t", ts: 9, recipe: [], times: {}, quality: 0.1 });
  logRun({ task: "t", ts: 7, recipe: [], times: {}, quality: 0.1 });
  expect(recentRuns("t", 2).map((r) => r.ts)).toEqual([9, 7]);
});
