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
  runAutoUpdate,
} from "../src/core/auto-update";

const HOUR = 60 * 60 * 1000;
const state = (lastCheckTs: number) => ({ lastCheckTs, lastRevision: "", lastStatus: "" as const, lastReason: "" });

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
