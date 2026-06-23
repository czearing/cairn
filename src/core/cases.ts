import { db } from "./db";

// Case-Based Reasoning outcome layer. Stage 1 (relevance) stays in search.ts; this is stage 2
// (effectiveness): re-rank already-relevant results by how well a node has worked when reused, and
// reinforce that record from outcomes. Outcome lives in a SIDECAR table (case_stats), so the neurons
// schema, sync, search, and embeddings are all untouched. Counters are mergeable (wins/losses sum),
// so syncing case_stats across devices later is a clean additive step, not a migration.

export interface CaseStat { id: string; uses: number; wins: number; losses: number; steps: number; lastUsed: number }

let ready = false;
function ensure(): void {
  if (ready) return;
  db().run("CREATE TABLE IF NOT EXISTS case_stats (id TEXT PRIMARY KEY, uses INTEGER NOT NULL DEFAULT 0, wins INTEGER NOT NULL DEFAULT 0, losses INTEGER NOT NULL DEFAULT 0, steps INTEGER NOT NULL DEFAULT 0, last_used INTEGER NOT NULL DEFAULT 0)");
  ready = true;
}

export function getStat(id: string): CaseStat | null {
  ensure();
  return (db().query("SELECT id, uses, wins, losses, steps, last_used AS lastUsed FROM case_stats WHERE id = ?").get(id) as CaseStat | undefined) ?? null;
}

// Record an outcome for a reused node. success bumps wins, else losses; `steps` keeps the LEANEST run
// seen (the lean path is what we want to reinforce); `now` is a ms timestamp. Idempotent upsert.
export function reinforce(id: string, success: boolean, steps: number, now: number): void {
  ensure();
  const cur = getStat(id);
  const uses = (cur?.uses ?? 0) + 1;
  const wins = (cur?.wins ?? 0) + (success ? 1 : 0);
  const losses = (cur?.losses ?? 0) + (success ? 0 : 1);
  const best = cur && cur.steps > 0 ? (steps > 0 ? Math.min(cur.steps, steps) : cur.steps) : steps;
  db().run("INSERT OR REPLACE INTO case_stats (id, uses, wins, losses, steps, last_used) VALUES (?, ?, ?, ?, ?, ?)", id, uses, wins, losses, best, now);
}

// ---- Scoring (pure, no db) ----
// Laplace prior so an unverified node sits at ~0.5, never an undeserved 1.0.
export const successRate = (s: CaseStat): number => (s.wins + 1) / (s.wins + s.losses + 2);
// ACT-R base-level approximation: frequency and recency of use, power-law decay.
export function baseLevel(s: CaseStat, now: number): number {
  const ageH = Math.max(0, (now - s.lastUsed) / 3_600_000);
  return Math.log(1 + s.uses) - 0.5 * Math.log(1 + ageH);
}
// Effectiveness of a node: how reliably and leanly it has worked, weighted by practice/recency.
export function effScore(s: CaseStat, now: number, minSteps: number): number {
  const stepEff = s.steps > 0 && minSteps > 0 ? minSteps / s.steps : 1;
  return successRate(s) * stepEff * (1 + Math.max(0, baseLevel(s, now)));
}

const neutral = (id: string, now: number): CaseStat => ({ id, uses: 0, wins: 0, losses: 0, steps: 0, lastUsed: now });

// Re-rank relevant results by effectiveness. NEVER drops a result (no recall loss) — it only reorders,
// so a node with no outcome history keeps a neutral baseline and is not unfairly buried. Ties break on
// the original relevance score.
export function rerank<T extends { id: string; score: number }>(results: T[], now: number): T[] {
  if (results.length < 2) return results;
  ensure();
  const stats = new Map(results.map((r) => [r.id, getStat(r.id) ?? neutral(r.id, now)]));
  const withSteps = [...stats.values()].filter((s) => s.steps > 0).map((s) => s.steps);
  const minSteps = withSteps.length ? Math.min(...withSteps) : 1;
  return [...results].sort((a, b) => {
    const e = effScore(stats.get(b.id)!, now, minSteps) - effScore(stats.get(a.id)!, now, minSteps);
    return e !== 0 ? e : b.score - a.score;
  });
}
