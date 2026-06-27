import { markReady, peersBusy, claimReviewFlag, readyRuns, clearReviewed, releaseReviewFlag, WAIT_MS, type ReadyRun } from "./coordinate";

// Orchestrates one session's post-turn review under the concurrency spec: mark this run ready, WAIT for sibling
// windows still working the same skill, CLAIM the per-skill review lock (or wait for the current reviewer), then
// review ALL coalesced runs in one pass and update the skill once. If another session holds the lock, this one
// returns without reviewing because that reviewer will include this run. `review`/`now`/`sleep` are injected so
// the whole flow is deterministically testable without real clocks, files, or an LLM.

export interface CoordDeps {
  review: (runs: ReadyRun[]) => Promise<void>; // review the coalesced runs and persist the master/runs
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  pollMs?: number;
}

export interface CoordResult { reviewed: boolean; count: number; reason: string }

export async function coordinatedReview(session: string, skill: string, output: string, transcript: string, deps: CoordDeps): Promise<CoordResult> {
  const now = deps.now ?? (() => Date.now());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const pollMs = deps.pollMs ?? 2000;
  const deadline = now() + WAIT_MS;

  markReady(session, skill, output, transcript, now());

  // 1) Hold for sibling windows still 'doing' this skill, so one review can cover all of them.
  while (peersBusy(skill, session, now()) > 0 && now() < deadline) await sleep(pollMs);

  // 2) Become THE reviewer, or wait for whoever currently holds the lock to finish. Attempt at least once even
  // if the peer-wait above already consumed the window, so a finisher that timed out still reviews alone.
  let claimed = false;
  do {
    if (claimReviewFlag(skill, session, now())) { claimed = true; break; }
    if (now() >= deadline) break;
    await sleep(pollMs);
  } while (true);
  if (!claimed) return { reviewed: false, count: 0, reason: "another session is reviewing this skill" };

  try {
    const runs = readyRuns(skill, now());
    if (runs.length === 0) return { reviewed: false, count: 0, reason: "already reviewed by a peer" };
    await deps.review(runs);                                  // one review over every coalesced run
    clearReviewed(skill, runs.map((r) => r.session));
    return { reviewed: true, count: runs.length, reason: "reviewed" };
  } finally {
    releaseReviewFlag(skill, session);
  }
}

export { WAIT_MS };
