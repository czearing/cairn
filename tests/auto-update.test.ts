import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  autoUpdateDue,
  autoUpdateIntervalMs,
  autoUpdateStatePath,
  claimAutoUpdate,
  fastForwardDecision,
  maybeAutoUpdate,
  readAutoUpdateState,
  recordAutoUpdateResult,
  retryDelayMs,
  runAutoUpdate,
} from "../src/core/auto-update";

const HOUR = 60 * 60 * 1000;
const MINUTE = 60 * 1000;
const state = (lastCheckTs: number, overrides: { consecutiveFailures?: number; nextCheckTs?: number } = {}) => ({
  lastCheckTs,
  lastRevision: "",
  lastStatus: "" as const,
  lastReason: "",
  consecutiveFailures: overrides.consecutiveFailures ?? 0,
  nextCheckTs: overrides.nextCheckTs ?? 0,
});

let dir = "";
const previousDir = process.env.CAIRN_AUTO_UPDATE_DIR;
const previousInterval = process.env.CAIRN_AUTO_UPDATE_INTERVAL_MS;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cairn-auto-update-"));
  process.env.CAIRN_AUTO_UPDATE_DIR = dir;
  delete process.env.CAIRN_AUTO_UPDATE_INTERVAL_MS;
});

afterEach(() => {
  if (previousDir === undefined) delete process.env.CAIRN_AUTO_UPDATE_DIR;
  else process.env.CAIRN_AUTO_UPDATE_DIR = previousDir;
  if (previousInterval === undefined) delete process.env.CAIRN_AUTO_UPDATE_INTERVAL_MS;
  else process.env.CAIRN_AUTO_UPDATE_INTERVAL_MS = previousInterval;
  rmSync(dir, { recursive: true, force: true });
});

describe("auto-update throttle", () => {
  test("a never-checked install is due immediately", () => {
    expect(autoUpdateDue(state(0), 1_000, HOUR)).toBe(true);
  });

  test("a recent check is not due again", () => {
    expect(autoUpdateDue(state(10 * HOUR), 10 * HOUR + 60_000, HOUR)).toBe(false);
  });

  test("the check becomes due once the interval elapses", () => {
    expect(autoUpdateDue(state(10 * HOUR), 11 * HOUR, HOUR)).toBe(true);
  });

  test("a future stamp from clock skew never wedges updates off", () => {
    expect(autoUpdateDue(state(99 * HOUR), 10 * HOUR, HOUR)).toBe(true);
  });

  test("the interval is configurable and rejects nonsense values", () => {
    expect(autoUpdateIntervalMs()).toBe(HOUR);
    process.env.CAIRN_AUTO_UPDATE_INTERVAL_MS = "5000";
    expect(autoUpdateIntervalMs()).toBe(5000);
    process.env.CAIRN_AUTO_UPDATE_INTERVAL_MS = "not-a-number";
    expect(autoUpdateIntervalMs()).toBe(HOUR);
  });
});

describe("fast-forward policy", () => {
  const inputs = {
    gitCheckout: true,
    dirty: false,
    localHead: "aaa",
    remoteHead: "bbb",
    remoteIsDescendant: true,
  };

  test("a clean checkout behind origin is fast-forwarded", () => {
    expect(fastForwardDecision(inputs)).toMatchObject({ update: true, status: "updated" });
  });

  test("an install already on the published release does nothing", () => {
    expect(fastForwardDecision({ ...inputs, remoteHead: "aaa" }))
      .toMatchObject({ update: false, status: "current" });
  });

  test("uncommitted work is never stashed or discarded in the background", () => {
    expect(fastForwardDecision({ ...inputs, dirty: true }))
      .toMatchObject({ update: false, status: "skipped", reason: "local changes present" });
  });

  test("a diverged checkout stays manual", () => {
    expect(fastForwardDecision({ ...inputs, remoteIsDescendant: false }))
      .toMatchObject({ update: false, status: "skipped" });
  });

  test("a non-git install is skipped rather than failed", () => {
    expect(fastForwardDecision({ ...inputs, gitCheckout: false }))
      .toMatchObject({ update: false, status: "skipped" });
  });

  test("unresolvable revisions are reported as a failure", () => {
    expect(fastForwardDecision({ ...inputs, remoteHead: "" }))
      .toMatchObject({ update: false, status: "failed" });
  });
});

describe("claim and stamp", () => {
  test("only the first concurrent turn claims an interval", () => {
    expect(claimAutoUpdate(5 * HOUR)).toBe(true);
    expect(claimAutoUpdate(5 * HOUR)).toBe(false);
    expect(claimAutoUpdate(6 * HOUR + 1)).toBe(true);
  });

  test("the recorded result is readable for status reporting", () => {
    recordAutoUpdateResult({ status: "updated", from: "aaa", to: "bbb", reason: "fast-forwarded to origin/main" }, 42);
    expect(readAutoUpdateState()).toEqual({
      lastCheckTs: 42,
      lastRevision: "bbb",
      lastStatus: "updated",
      lastReason: "fast-forwarded to origin/main",
      consecutiveFailures: 0,
      nextCheckTs: 42 + HOUR,
    });
  });

  test("a corrupt stamp reads as never-checked instead of throwing", () => {
    writeFileSync(autoUpdateStatePath(), "{not json");
    expect(readAutoUpdateState().lastCheckTs).toBe(0);
  });
});

const git = (cwd: string, ...args: string[]) => {
  const run = Bun.spawnSync(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
  });
  if (!run.success) throw new Error(new TextDecoder().decode(run.stderr));
};

describe("runAutoUpdate against a real local origin", () => {
  test("it pulls a published commit and refuses once work is uncommitted", () => {    const origin = join(dir, "origin");
    const clone = join(dir, "clone");
    mkdirSync(origin, { recursive: true });
    git(origin, "init", "--initial-branch=main", ".");
    writeFileSync(join(origin, "file.txt"), "v1");
    git(origin, "add", ".");
    git(origin, "commit", "-m", "v1");
    git(dir, "clone", "--quiet", origin, clone);

    // Nothing published since the clone: the install is already current.
    expect(runAutoUpdate({ root: clone, install: false }).status).toBe("current");

    writeFileSync(join(origin, "file.txt"), "v2");
    git(origin, "add", ".");
    git(origin, "commit", "-m", "v2");

    const updated = runAutoUpdate({ root: clone, install: false });
    expect(updated.status).toBe("updated");
    expect(readFileSync(join(clone, "file.txt"), "utf8")).toBe("v2");

    writeFileSync(join(origin, "file.txt"), "v3");
    git(origin, "add", ".");
    git(origin, "commit", "-m", "v3");
    writeFileSync(join(clone, "file.txt"), "local work in progress");

    const blocked = runAutoUpdate({ root: clone, install: false });
    expect(blocked.status).toBe("skipped");
    expect(readFileSync(join(clone, "file.txt"), "utf8")).toBe("local work in progress");
  }, 30_000);

  test("a plain directory is skipped without throwing", () => {
    expect(runAutoUpdate({ root: join(dir, "not-a-repo"), install: false }).status).toBe("skipped");
  });

  test("a test run never launches a background updater against the developer's checkout", () => {
    // Belt and braces: tests/setup.ts disables auto-update for the whole run, and the in-process
    // argv guard independently refuses even if that env kill switch is somehow enabled.
    expect(maybeAutoUpdate(Date.now() + 365 * 24 * HOUR)).toBe(false);
    process.env.CAIRN_AUTO_UPDATE = "1";
    try {
      expect(maybeAutoUpdate(Date.now() + 365 * 24 * HOUR)).toBe(false);
    } finally {
      process.env.CAIRN_AUTO_UPDATE = "0";
    }
  });
});

// A transient blip — no network on a laptop lid-open, a blocked fetch, a VPN flap — used to cost a
// full hour of update latency, because every result stamped lastCheckTs and the throttle only ever
// asked whether one interval had elapsed. A published fix then sat undelivered for an hour per blip.
describe("failure backoff", () => {
  test("a healthy check keeps the normal cadence", () => {
    expect(retryDelayMs(0, HOUR)).toBe(HOUR);
  });

  test("a failed check retries in a minute and doubles, never exceeding the interval", () => {
    expect(retryDelayMs(1, HOUR)).toBe(MINUTE);
    expect(retryDelayMs(2, HOUR)).toBe(2 * MINUTE);
    expect(retryDelayMs(3, HOUR)).toBe(4 * MINUTE);
    // A persistently broken checkout must not be retried every turn forever.
    expect(retryDelayMs(20, HOUR)).toBe(HOUR);
    // Backoff can only make a check sooner, never later than the steady-state cadence.
    for (let n = 1; n <= 20; n++) expect(retryDelayMs(n, HOUR)).toBeLessThanOrEqual(HOUR);
  });

  test("a fetch failure schedules a fast retry instead of burning the interval", () => {
    recordAutoUpdateResult({ status: "failed", from: "aaa", to: "", reason: "fetch failed: network" }, 10 * HOUR);
    const after = readAutoUpdateState();
    expect(after.consecutiveFailures).toBe(1);
    expect(after.nextCheckTs).toBe(10 * HOUR + MINUTE);
    expect(autoUpdateDue(after, 10 * HOUR + MINUTE, HOUR)).toBe(true);
    // Still throttled before the retry window; a blip must not mean a check every single turn.
    expect(autoUpdateDue(after, 10 * HOUR + 30_000, HOUR)).toBe(false);
  });

  test("a success clears the backoff so failures do not accumulate forever", () => {
    recordAutoUpdateResult({ status: "failed", from: "aaa", to: "", reason: "fetch failed" }, HOUR);
    recordAutoUpdateResult({ status: "failed", from: "aaa", to: "", reason: "fetch failed" }, 2 * HOUR);
    expect(readAutoUpdateState().consecutiveFailures).toBe(2);
    recordAutoUpdateResult({ status: "current", from: "aaa", to: "aaa", reason: "already up to date" }, 3 * HOUR);
    const healthy = readAutoUpdateState();
    expect(healthy.consecutiveFailures).toBe(0);
    expect(healthy.nextCheckTs).toBe(3 * HOUR + HOUR);
  });

  test("a skipped check keeps the normal cadence because a fast retry cannot clear it", () => {
    // "local changes present" is a standing condition; retrying every minute would be pure noise.
    recordAutoUpdateResult({ status: "skipped", from: "aaa", to: "bbb", reason: "local changes present" }, HOUR);
    const after = readAutoUpdateState();
    expect(after.consecutiveFailures).toBe(0);
    expect(after.nextCheckTs).toBe(2 * HOUR);
  });

  test("state written before nextCheckTs existed still throttles on the interval", () => {
    expect(autoUpdateDue(state(10 * HOUR), 10 * HOUR + 60_000, HOUR)).toBe(false);
    expect(autoUpdateDue(state(10 * HOUR), 11 * HOUR, HOUR)).toBe(true);
  });

  test("a claimed interval reserves a full interval so a dead worker cannot spawn one per turn", () => {
    expect(claimAutoUpdate(5 * HOUR)).toBe(true);
    expect(readAutoUpdateState().nextCheckTs).toBe(6 * HOUR);
    expect(claimAutoUpdate(5 * HOUR + 60_000)).toBe(false);
  });
});
