import { homedir } from "node:os";
import { join } from "node:path";
import { readdirSync, readFileSync, writeFileSync, mkdirSync, rmSync, openSync, closeSync, statSync } from "node:fs";

// Coordination for concurrent same-skill reviews (Caleb's spec). The UserPromptSubmit hook runs READ-ONLY, so
// this state lives in small files under ~/.cairn/inflight (file writes are always allowed and are cross-process
// safe), not in the read-only brain db. Flow:
//   - A window REGISTERS the skill it is working on the moment that skill's steps are injected (status 'doing').
//   - When its turn ends it marks that file 'ready' with the output.
//   - A reviewer CLAIMS a per-skill lock (atomic O_EXCL create) so only one session reviews a skill at a time.
//   - A finisher waits up to WAIT_MS for siblings still 'doing' and for a held lock, then proceeds alone.
// The wait window is high so a finisher does not give up too early on a sibling window left idle.

export const WAIT_MS = Number(process.env.CAIRN_REVIEW_WAIT_MS || String(30 * 60_000)); // 30 min: how long a finisher will hold the lock / wait out the deadline
const EXPIRE_MS = WAIT_MS * 4; // a far longer horizon before a leftover run/lock file is deleted, so a 'ready' run that waited out the window is never dropped before it is reviewed
// How recent a 'doing' peer must be to still count as ACTIVELY working (and thus worth waiting to coalesce
// with). A real turn marks ready within minutes; a 'doing' file older than this is an abandoned window (the
// user closed it, or it registered at inject but never finished) and must NOT block a real review. Much
// shorter than WAIT_MS so stale registrations never stall the learner for the full wait window.
export const ACTIVE_MS = Number(process.env.CAIRN_PEER_ACTIVE_MS || String(10 * 60_000)); // 10 min

const DIR = process.env.CAIRN_INFLIGHT_DIR || join(homedir(), ".cairn", "inflight");
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "x";
const runFile = (session: string, skill: string) => join(DIR, `${slug(session)}__${slug(skill)}.run.json`);
const lockFile = (skill: string) => join(DIR, `${slug(skill)}.lock`);
function ensureDir(): void { try { mkdirSync(DIR, { recursive: true }); } catch { /* exists */ } }

interface RunFile { skill: string; session: string; status: "doing" | "ready"; output: string; transcript: string; ts: number }
function readRun(path: string): RunFile | null {
  try { return JSON.parse(readFileSync(path, "utf8")) as RunFile; } catch { return null; }
}

/** A window started working on `skill` (its curated steps were injected). Safe to call from the read-only hook. */
export function registerInflight(session: string, skill: string, ts: number): void {
  ensureDir();
  try { writeFileSync(runFile(session, skill), JSON.stringify({ skill, session, status: "doing", output: "", transcript: "", ts })); } catch { /* best-effort */ }
}

/** The window's turn ended: its run is ready for review, carrying the deliverable and transcript. */
export function markReady(session: string, skill: string, output: string, transcript: string, ts: number): void {
  ensureDir();
  try { writeFileSync(runFile(session, skill), JSON.stringify({ skill, session, status: "ready", output, transcript, ts })); } catch { /* best-effort */ }
}

/** The skill this session registered (the injected one), or null if it had no skill injected (a cold task). */
export function sessionSkill(session: string): string | null {
  ensureDir();
  const me = `${slug(session)}__`;
  let best: RunFile | null = null;
  try {
    for (const f of readdirSync(DIR)) {
      if (!f.startsWith(me) || !f.endsWith(".run.json")) continue;
      const r = readRun(join(DIR, f));
      if (r && (!best || r.ts > best.ts)) best = r;
    }
  } catch { /* none */ }
  return best?.skill ?? null;
}

function allRuns(skill: string, now: number): RunFile[] {
  ensureDir();
  const suffix = `__${slug(skill)}.run.json`;
  const out: RunFile[] = [];
  try {
    for (const f of readdirSync(DIR)) {
      if (!f.endsWith(suffix)) continue;
      const p = join(DIR, f);
      const r = readRun(p);
      if (!r) continue;
      if (r.ts <= now - EXPIRE_MS) { try { rmSync(p, { force: true }); } catch { /* keep going */ } continue; } // truly orphaned: self-clean
      out.push(r);
    }
  } catch { /* none */ }
  return out;
}

/** Count OTHER sessions still 'doing' this skill, ignoring abandoned ones (a 'doing' run older than the
 *  ACTIVE window is a window left mid-task, so we never wait on it forever). These are the siblings to hold for. */
export function peersBusy(skill: string, session: string, now: number): number {
  return allRuns(skill, now).filter((r) => r.status === "doing" && r.session !== session && r.ts > now - ACTIVE_MS).length;
}

export interface ReadyRun { session: string; output: string; transcript: string; ts: number }

/** All ready runs for this skill within the window: the set to coalesce into one review, oldest first. */
export function readyRuns(skill: string, now: number): ReadyRun[] {
  return allRuns(skill, now)
    .filter((r) => r.status === "ready")
    .sort((a, b) => a.ts - b.ts)
    .map((r) => ({ session: r.session, output: r.output, transcript: r.transcript, ts: r.ts }));
}

/** Atomically try to become THE reviewer for this skill. A stale lock (older than the wait window, from a
 *  crashed/abandoned reviewer) is cleared and retaken. Returns true only if we now hold the lock. */
export function claimReviewFlag(skill: string, session: string, now: number): boolean {
  ensureDir();
  const path = lockFile(skill);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, "wx"); // wx = create-exclusive, fails if it already exists
      writeFileSync(fd, JSON.stringify({ session, ts: now }));
      closeSync(fd);
      return true;
    } catch {
      // Lock held. Reclaim only if it is stale (the holder crashed or gave up past the wait window).
      try {
        const held = JSON.parse(readFileSync(path, "utf8")) as { session: string; ts: number };
        if (held.session === session) return true;       // we already hold it
        if (held.ts < now - WAIT_MS) { rmSync(path, { force: true }); continue; } // stale: drop and retry
      } catch { /* unreadable lock: treat as held */ }
      return false;
    }
  }
  return false;
}

/** Release our review lock for this skill (never another holder's). */
export function releaseReviewFlag(skill: string, session: string): void {
  const path = lockFile(skill);
  try {
    const held = JSON.parse(readFileSync(path, "utf8")) as { session: string };
    if (held.session === session) rmSync(path, { force: true });
  } catch { /* gone or not ours */ }
}

/** Drop the run files for the sessions just reviewed, clearing the coalesced set. */
export function clearReviewed(skill: string, sessions: string[]): void {
  for (const s of sessions) { try { rmSync(runFile(s, skill), { force: true }); } catch { /* gone */ } }
}

// Test/maintenance helper: the lock's holder, or null. Exposed for deterministic tests.
export function lockHolder(skill: string): string | null {
  try { return (JSON.parse(readFileSync(lockFile(skill), "utf8")) as { session: string }).session; } catch { return null; }
}
