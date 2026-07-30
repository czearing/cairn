#!/usr/bin/env bun
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { autoUpdateEnabled } from "./config";

// Cairn keeps ITSELF current. `cairn update` stays available, but an install must never sit on a broken
// release because a human forgot to run a command: every human turn start claims a throttled stamp and,
// when due, spawns one detached worker that fast-forwards the checkout and re-applies the idempotent
// installer. The turn-side check is pure local file I/O, so a hook never waits on git or the network.
//
// The worker refuses to touch a checkout that is dirty or has diverged from origin/main: a developer's
// work in progress is never stashed, rebased, or discarded behind their back. Those cases stay manual.

const ROOT = resolve(import.meta.dir, "..", "..");
const DEFAULT_INTERVAL_MS = 60 * 60 * 1000;
const LOCK_STALE_MS = 15 * 60 * 1000;

type AutoUpdateStatus = "updated" | "current" | "skipped" | "failed";

interface AutoUpdateState {
  lastCheckTs: number;
  lastRevision: string;
  lastStatus: AutoUpdateStatus | "";
  lastReason: string;
}

interface AutoUpdateResult {
  status: AutoUpdateStatus;
  from: string;
  to: string;
  reason: string;
}

interface FastForwardInputs {
  gitCheckout: boolean;
  dirty: boolean;
  localHead: string;
  remoteHead: string;
  remoteIsDescendant: boolean;
}

const stateDirectory = (): string =>
  process.env.CAIRN_AUTO_UPDATE_DIR || join(homedir(), ".cairn");
export const autoUpdateStatePath = (): string => join(stateDirectory(), "auto-update.json");
const lockPath = (): string => join(stateDirectory(), "auto-update.lock");
const autoUpdateLogPath = (): string => join(stateDirectory(), "auto-update.log");

export const autoUpdateIntervalMs = (): number => {
  const configured = Number(process.env.CAIRN_AUTO_UPDATE_INTERVAL_MS || "");
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_INTERVAL_MS;
};

export function readAutoUpdateState(): AutoUpdateState {
  try {
    const parsed = JSON.parse(readFileSync(autoUpdateStatePath(), "utf8")) as Partial<AutoUpdateState>;
    return {
      lastCheckTs: Number(parsed.lastCheckTs || 0),
      lastRevision: String(parsed.lastRevision || ""),
      lastStatus: (parsed.lastStatus || "") as AutoUpdateState["lastStatus"],
      lastReason: String(parsed.lastReason || ""),
    };
  } catch {
    return { lastCheckTs: 0, lastRevision: "", lastStatus: "", lastReason: "" };
  }
}

function writeAutoUpdateState(state: AutoUpdateState): void {
  const path = autoUpdateStatePath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(state));
}

/** Pure throttle: a check is due once the interval has elapsed, and always on a first or clock-skewed run. */
export function autoUpdateDue(state: AutoUpdateState, now: number, intervalMs: number): boolean {
  if (!state.lastCheckTs) return true;
  if (state.lastCheckTs > now) return true;
  return now - state.lastCheckTs >= intervalMs;
}

/** Pure policy: only a clean checkout that origin strictly moved ahead of is fast-forwarded. */
export function fastForwardDecision(inputs: FastForwardInputs): { update: boolean; status: AutoUpdateStatus; reason: string } {
  if (!inputs.gitCheckout) return { update: false, status: "skipped", reason: "not a git checkout" };
  if (inputs.dirty) return { update: false, status: "skipped", reason: "local changes present" };
  if (!inputs.localHead || !inputs.remoteHead) return { update: false, status: "failed", reason: "could not resolve revisions" };
  if (inputs.localHead === inputs.remoteHead) return { update: false, status: "current", reason: "already up to date" };
  if (!inputs.remoteIsDescendant) return { update: false, status: "skipped", reason: "checkout diverged from origin/main" };
  return { update: true, status: "updated", reason: "fast-forwarded to origin/main" };
}

function claimLock(now: number): boolean {
  const path = lockPath();
  mkdirSync(dirname(path), { recursive: true });
  try {
    writeFileSync(path, JSON.stringify({ pid: process.pid, ts: now }), { flag: "wx" });
    return true;
  } catch {
    try {
      if (now - statSync(path).mtimeMs > LOCK_STALE_MS) {
        rmSync(path, { force: true });
        writeFileSync(path, JSON.stringify({ pid: process.pid, ts: now }), { flag: "wx" });
        return true;
      }
    } catch { /* another worker owns the lock */ }
    return false;
  }
}

const releaseLock = (): void => { try { rmSync(lockPath(), { force: true }); } catch { /* already gone */ } };

/** Reserve this interval's check before spawning, so concurrent turns never launch duplicate workers. */
export function claimAutoUpdate(now = Date.now()): boolean {
  try {
    const state = readAutoUpdateState();
    if (!autoUpdateDue(state, now, autoUpdateIntervalMs())) return false;
    writeAutoUpdateState({ ...state, lastCheckTs: now });
    return true;
  } catch {
    return false;
  }
}

const text = (value: Uint8Array): string => new TextDecoder().decode(value).trim();
function sh(command: string[], cwd: string): { ok: boolean; out: string; err: string } {
  const run = Bun.spawnSync(command, { cwd, stdout: "pipe", stderr: "pipe" });
  return { ok: run.success, out: text(run.stdout), err: text(run.stderr) };
}

export function runAutoUpdate(
  options: { root?: string; install?: boolean } = {},
): AutoUpdateResult {
  const root = options.root || ROOT;
  const git = Bun.which("git");
  const gitCheckout = Boolean(git) && existsSync(join(root, ".git"));
  if (!git || !gitCheckout) {
    return { status: "skipped", from: "", to: "", reason: "not a git checkout" };
  }
  const localHead = sh([git, "-C", root, "rev-parse", "HEAD"], root).out;
  const dirty = sh([git, "-C", root, "status", "--porcelain", "--untracked-files=no"], root).out.length > 0;
  const fetch = sh([git, "-C", root, "fetch", "--quiet", "origin", "main"], root);
  if (!fetch.ok) {
    return { status: "failed", from: localHead, to: "", reason: `fetch failed: ${fetch.err.split("\n")[0] ?? ""}` };
  }
  const remoteHead = sh([git, "-C", root, "rev-parse", "FETCH_HEAD"], root).out;
  const decision = fastForwardDecision({
    gitCheckout,
    dirty,
    localHead,
    remoteHead,
    remoteIsDescendant: sh([git, "-C", root, "merge-base", "--is-ancestor", localHead, remoteHead], root).ok,
  });
  if (!decision.update) {
    return { status: decision.status, from: localHead, to: remoteHead, reason: decision.reason };
  }
  const merge = sh([git, "-C", root, "merge", "--ff-only", remoteHead], root);
  if (!merge.ok) {
    return { status: "failed", from: localHead, to: remoteHead, reason: `fast-forward failed: ${merge.err.split("\n")[0] ?? ""}` };
  }
  if (options.install !== false) {
    const bun = Bun.which("bun") ?? "bun";
    sh([bun, "install"], root);
    // The new release may add hooks, MCP fields, or commands, so re-apply the idempotent installer —
    // exactly what `cairn update` does, so an auto-updated install is identical to a manual one.
    const install = sh([bun, join(root, "src", "cli.ts"), "install"], root);
    if (!install.ok) {
      return { status: "failed", from: localHead, to: remoteHead, reason: `install failed: ${install.err.split("\n")[0] ?? ""}` };
    }
  }
  return { status: "updated", from: localHead, to: remoteHead, reason: decision.reason };
}

export function recordAutoUpdateResult(result: AutoUpdateResult, now = Date.now()): void {
  try {
    writeAutoUpdateState({
      lastCheckTs: now,
      lastRevision: result.to || result.from,
      lastStatus: result.status,
      lastReason: result.reason,
    });
  } catch { /* the stamp is advisory; a failed write only means an earlier retry */ }
}

/** Turn-start entry point. Never blocks: it claims the throttle locally and hands the work to a
 *  detached worker, so a hook returns before any git or network call begins. */
export function maybeAutoUpdate(now = Date.now()): boolean {
  try {
    if (!autoUpdateEnabled()) return false;
    if (process.env.CAIRN_SKILL_WORKER === "1" || process.env.CAIRN_PROMPT_BENCHMARK_SESSION) return false;
    // Same reasoning as the real-brain guard in core/db.ts: a test run must never mutate the
    // developer's checkout, so hook tests that replay a turn start can't launch a real updater.
    if (process.argv.some((arg) => arg === "test" || arg.endsWith(".test.ts"))) return false;
    if (!existsSync(join(ROOT, ".git"))) return false;
    if (!claimAutoUpdate(now)) return false;
    const bun = Bun.which("bun") ?? process.execPath;
    spawn(bun, [join(ROOT, "src", "core", "auto-update.ts")], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: { ...process.env },
    }).unref();
    return true;
  } catch {
    return false;
  }
}

if (import.meta.main) {
  const now = Date.now();
  if (claimLock(now)) {
    try {
      const result = runAutoUpdate();
      recordAutoUpdateResult(result, Date.now());
      try {
        mkdirSync(stateDirectory(), { recursive: true });
        writeFileSync(
          autoUpdateLogPath(),
          `${new Date().toISOString()} ${result.status} ${result.from.slice(0, 7)}->${result.to.slice(0, 7)} ${result.reason}\n`,
          { flag: "a" },
        );
      } catch { /* logging is advisory */ }
    } finally {
      releaseLock();
    }
  }
  process.exit(0);
}
