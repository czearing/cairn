import { test, expect } from "bun:test";
import { rerank, reinforce } from "../src/core/cases";
import { db } from "../src/core/db";

// Stage-2 effectiveness re-ranking reads the case_stats sidecar. That sidecar can be unavailable: a
// read-only connection (hooks) can't CREATE it, and a stale read path may not see it yet. When it is,
// search must still return its stage-1 relevance results, never throw. (This is the bug that broke a
// live brain_search with "no such table: case_stats".)
test("rerank/reinforce never throw when the case_stats sidecar is unavailable", () => {
  reinforce("seed", 1, 2, 1000);                 // create the table, then yank it out from under us
  db().run("DROP TABLE IF EXISTS case_stats");
  expect(() => reinforce("a", 1, 2, 1000)).not.toThrow();        // write path degrades to a silent no-op
  let out: { id: string; score: number }[] = [];
  expect(() => { out = rerank([{ id: "a", score: 0.9 }, { id: "b", score: 0.8 }], 1000); }).not.toThrow();
  expect(out.map((r) => r.id)).toEqual(["a", "b"]);              // stage-1 relevance order preserved
  db().run("CREATE TABLE IF NOT EXISTS case_stats (id TEXT PRIMARY KEY, uses INTEGER NOT NULL DEFAULT 0, wins INTEGER NOT NULL DEFAULT 0, losses INTEGER NOT NULL DEFAULT 0, steps INTEGER NOT NULL DEFAULT 0, last_used INTEGER NOT NULL DEFAULT 0)");
});
