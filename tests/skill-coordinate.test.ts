import { test, expect, beforeEach } from "bun:test";
import { rmSync, mkdirSync, readdirSync } from "node:fs";
import {
  registerInflight, markReady, sessionSkill, peersBusy, readyRuns,
  claimReviewFlag, releaseReviewFlag, clearReviewed, lockHolder, WAIT_MS,
} from "../src/skill/coordinate";

const DIR = process.env.CAIRN_INFLIGHT_DIR!;
beforeEach(() => { try { rmSync(DIR, { recursive: true, force: true }); } catch { /* none */ } mkdirSync(DIR, { recursive: true }); });

const T = 1_000_000; // a base "now"

test("registerInflight + sessionSkill: a session reports the skill it was injected with", () => {
  registerInflight("sessA", "haiku", T);
  expect(sessionSkill("sessA")).toBe("haiku");
  expect(sessionSkill("sessUnknown")).toBeNull();
});

test("peersBusy counts OTHER sessions still doing the same skill, not self", () => {
  registerInflight("A", "haiku", T);
  registerInflight("B", "haiku", T);
  registerInflight("C", "poem", T);          // different skill, ignored
  expect(peersBusy("haiku", "A", T)).toBe(1); // only B
  expect(peersBusy("haiku", "B", T)).toBe(1); // only A
  expect(peersBusy("poem", "C", T)).toBe(0);
});

test("a run goes from doing to ready, and ready runs are collected oldest-first", () => {
  registerInflight("A", "haiku", T);
  registerInflight("B", "haiku", T);
  expect(readyRuns("haiku", T)).toEqual([]);
  markReady("B", "haiku", "B out", "B tx", T + 2);
  markReady("A", "haiku", "A out", "A tx", T + 1);
  expect(peersBusy("haiku", "A", T + 3)).toBe(0);   // both now ready, none doing
  const runs = readyRuns("haiku", T + 3);
  expect(runs.map((r) => r.session)).toEqual(["A", "B"]); // oldest ts first
  expect(runs.map((r) => r.output)).toEqual(["A out", "B out"]);
});

test("only one session can hold the per-skill review lock at a time", () => {
  expect(claimReviewFlag("haiku", "A", T)).toBe(true);
  expect(claimReviewFlag("haiku", "B", T)).toBe(false); // A holds it
  expect(lockHolder("haiku")).toBe("A");
  expect(claimReviewFlag("haiku", "A", T)).toBe(true);  // re-claim by the holder is fine
  releaseReviewFlag("haiku", "A");
  expect(claimReviewFlag("haiku", "B", T)).toBe(true);  // freed, B can take it
});

test("a session never releases another holder's lock", () => {
  claimReviewFlag("haiku", "A", T);
  releaseReviewFlag("haiku", "B");          // B is not the holder, must be a no-op
  expect(lockHolder("haiku")).toBe("A");
});

test("a stale lock (older than the wait window) is reclaimed", () => {
  claimReviewFlag("haiku", "A", T);                       // A holds at T
  expect(claimReviewFlag("haiku", "B", T + 1000)).toBe(false); // still fresh
  expect(claimReviewFlag("haiku", "B", T + WAIT_MS + 1)).toBe(true); // A's lock is now stale -> B takes over
  expect(lockHolder("haiku")).toBe("B");
});

test("clearReviewed removes the reviewed sessions' run files", () => {
  registerInflight("A", "haiku", T);
  registerInflight("B", "haiku", T);
  markReady("A", "haiku", "a", "a", T);
  markReady("B", "haiku", "b", "b", T);
  clearReviewed("haiku", ["A", "B"]);
  expect(readyRuns("haiku", T + 1)).toEqual([]);
});

test("an abandoned doing-run is ignored after the wait window, and the file is cleaned far later", () => {
  registerInflight("old", "haiku", T);
  expect(peersBusy("haiku", "other", T + WAIT_MS + 1)).toBe(0);                 // not waited on past the window
  expect(readdirSync(DIR).filter((f) => f.includes("__haiku.run.json")).length).toBe(1); // file still present (ready runs must survive the wait)
  expect(peersBusy("haiku", "other", T + WAIT_MS * 4 + 1)).toBe(0);             // far past EXPIRE: scan deletes it
  expect(readdirSync(DIR).filter((f) => f.includes("__haiku.run.json")).length).toBe(0);
});
