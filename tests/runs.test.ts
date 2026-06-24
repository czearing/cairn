import { test, expect, beforeEach } from "bun:test";
import { logRun, topRuns, recentRuns, appendToRun, routeTask } from "../src/core/cases";
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

test("feedback appends to the EXISTING run, not a new one", () => {
  const id = logRun({ task: "poem", ts: 1, recipe: ["creative", "draft"], times: { creative: 8, draft: 3 }, quality: 0.7 });
  appendToRun(id, { step: "revise: sharper imagery (from critique)", time: 4, quality: 0.85 });
  const runs = recentRuns("poem", 10);
  expect(runs.length).toBe(1);                                         // still ONE run, extended in place
  expect(runs[0]!.recipe).toEqual(["creative", "draft", "revise: sharper imagery (from critique)"]);
  expect(runs[0]!.times["revise: sharper imagery (from critique)"]).toBe(4);
  expect(runs[0]!.quality).toBe(0.85);
});

test("poem then haiku stay distinct; feedback lands on the right one", () => {
  const poem = logRun({ task: "poem", ts: 1, recipe: ["creative"], times: { creative: 8 }, quality: 0.7 });
  const haiku = logRun({ task: "haiku", ts: 2, recipe: ["syllable_575"], times: { syllable_575: 2 }, quality: 0.6 });
  // a critique on the poem (route: not a new task type -> continue current "poem")
  const r1 = routeTask(null, "poem");
  expect(r1).toEqual({ task: "poem", isNew: false });
  appendToRun(poem, { step: "revise per critique", time: 3 });
  // a new haiku request mid-thread is a DISTINCT bucket, never merged into poem
  const r2 = routeTask("haiku", "poem");
  expect(r2).toEqual({ task: "haiku", isNew: true });
  expect(topRuns("poem", 5).length).toBe(1);
  expect(topRuns("haiku", 5).length).toBe(1);
  expect(topRuns("poem", 5)[0]!.recipe).toContain("revise per critique");        // feedback on poem
  expect(topRuns("haiku", 5)[0]!.recipe).not.toContain("revise per critique");    // not on haiku
});
