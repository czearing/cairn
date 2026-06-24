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

// Record an outcome for a reused node. `outcome` is a GRADED quality score in [0,1] (a judge's rating
// of how good AND efficient the run was), or a boolean for the binary case (true=1, false=0). The score
// accumulates into wins (and 1-score into losses), so `wins` is the sum of scores and the success rate
// below is the MEAN score: an "adequate" run (~0.5) pulls the mean down just like a partial failure, so
// adequate-and-slow loses to excellent-and-lean. `steps` keeps the leanest run seen. Idempotent upsert.
export function reinforce(id: string, outcome: number | boolean, steps: number, now: number): void {
  ensure();
  const s = outcome === true ? 1 : outcome === false ? 0 : Math.max(0, Math.min(1, outcome));
  const cur = getStat(id);
  const uses = (cur?.uses ?? 0) + 1;
  const wins = (cur?.wins ?? 0) + s;
  const losses = (cur?.losses ?? 0) + (1 - s);
  const best = cur && cur.steps > 0 ? (steps > 0 ? Math.min(cur.steps, steps) : cur.steps) : steps;
  db().run("INSERT OR REPLACE INTO case_stats (id, uses, wins, losses, steps, last_used) VALUES (?, ?, ?, ?, ?, ?)", id, uses, wins, losses, best, now);
}

// ---- Scoring (pure, no db) ----
// Mean quality score with a Laplace prior, so an unverified node sits at ~0.5, never an undeserved 1.0.
// (wins is the sum of graded scores, wins+losses is the use count, so this is the average score.)
export const successRate = (s: CaseStat): number => (s.wins + 1) / (s.wins + s.losses + 2);
// Recency nudge in (0,1]: a recently-validated case surfaces first; mild, never dominates success.
export function recency(s: CaseStat, now: number): number {
  const ageDays = Math.max(0, (now - s.lastUsed) / 86_400_000);
  return 1 / (1 + ageDays);
}
// Effectiveness, DOMINATED by success rate and step efficiency (the "highest positive result, fewest
// steps" objective); recency is only a nudge. Crucially there is NO raw use-frequency term: an ACT-R
// base-level over use COUNT over-rewards a frequently-served BAD case (the closed-loop test proves it).
// Repetition still strengthens a case, but only through the success rate's Laplace confidence.
export function effScore(s: CaseStat, now: number, minSteps: number): number {
  const stepEff = s.steps > 0 && minSteps > 0 ? minSteps / s.steps : 1;
  return successRate(s) * stepEff * recency(s, now);
}

const neutral = (id: string, now: number): CaseStat => ({ id, uses: 0, wins: 0, losses: 0, steps: 0, lastUsed: now });

// Success rates within this band are treated as "equally reliable", so the leaner path wins. Wide
// enough that two genuinely-working paths tie and step-count decides; far narrower than the gap to a
// failing path, so a low-quality shortcut can NEVER beat a working path on step-count alone.
export const SUCCESS_BAND = 0.15;

// Re-rank relevant results by effectiveness, LEXICOGRAPHICALLY so quality strictly dominates speed:
//   1. clearly higher success rate wins (a path that skips an essential step and fails the gate can
//      never be rescued by being shorter — the guardrail);
//   2. among equally-reliable paths, FEWER known steps wins (gets leaner with practice — the growth);
//   3. then most-recently-validated, then original relevance.
// Never drops a result; a node with no history keeps a neutral baseline (unknown step count).
export function rerank<T extends { id: string; score: number }>(results: T[], now: number): T[] {
  if (results.length < 2) return results;
  ensure();
  const st = new Map(results.map((r) => [r.id, getStat(r.id) ?? neutral(r.id, now)]));
  return [...results].sort((ra, rb) => {
    const a = st.get(ra.id)!, b = st.get(rb.id)!;
    const sd = successRate(b) - successRate(a);
    if (Math.abs(sd) > SUCCESS_BAND) return sd;
    const as = a.steps > 0 ? a.steps : Infinity, bs = b.steps > 0 ? b.steps : Infinity;
    if (as !== bs) return as - bs;
    const rd = recency(b, now) - recency(a, now);
    return Math.abs(rd) > 1e-9 ? rd : rb.score - ra.score;
  });
}

// ---- Run log ----
// case_stats above is the AGGREGATE per-node score (fast ranking). This is the per-RUN history a new run
// inspects: each run's recipe (ordered step names), per-step times, and quality. Sidecar like case_stats
// (no neurons/sync impact). `topRuns(task, n)` pulls the n best prior runs so the screen can diff their
// recipes for candidate quality drivers, and the times give the bottleneck view.

export interface RunRecord { task: string; ts: number; recipe: string[]; times: Record<string, number>; quality: number }

let runsReady = false;
function ensureRuns(): void {
  if (runsReady) return;
  db().run("CREATE TABLE IF NOT EXISTS runs (id INTEGER PRIMARY KEY AUTOINCREMENT, task TEXT NOT NULL, ts INTEGER NOT NULL, recipe TEXT NOT NULL, times TEXT NOT NULL, quality REAL NOT NULL)");
  db().run("CREATE INDEX IF NOT EXISTS runs_task_q ON runs (task, quality)");
  runsReady = true;
}

// Append one completed run.
export function logRun(r: RunRecord): void {
  ensureRuns();
  db().run("INSERT INTO runs (task, ts, recipe, times, quality) VALUES (?, ?, ?, ?, ?)", r.task, r.ts, JSON.stringify(r.recipe), JSON.stringify(r.times), r.quality);
}

const parseRun = (row: { task: string; ts: number; recipe: string; times: string; quality: number }): RunRecord => ({
  task: row.task, ts: row.ts, quality: row.quality,
  recipe: (() => { try { return JSON.parse(row.recipe); } catch { return []; } })(),
  times: (() => { try { return JSON.parse(row.times); } catch { return {}; } })(),
});

// The n highest-quality prior runs for a task (the "look at the top 10" the optimizer screens).
export function topRuns(task: string, n = 10): RunRecord[] {
  ensureRuns();
  return (db().query("SELECT task, ts, recipe, times, quality FROM runs WHERE task = ? ORDER BY quality DESC, ts DESC LIMIT ?").all(task, n) as Parameters<typeof parseRun>[0][]).map(parseRun);
}

// The n most recent prior runs for a task.
export function recentRuns(task: string, n = 10): RunRecord[] {
  ensureRuns();
  return (db().query("SELECT task, ts, recipe, times, quality FROM runs WHERE task = ? ORDER BY ts DESC LIMIT ?").all(task, n) as Parameters<typeof parseRun>[0][]).map(parseRun);
}
