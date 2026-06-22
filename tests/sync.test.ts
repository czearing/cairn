import { test, expect } from "bun:test";
import { needsFullSync, type SyncState } from "../src/core/sync";

// The O(1) gate that keeps an idle sync tick at a single remote read. A full O(N) reconcile runs only
// when something actually changed, or on the periodic safety-net pass for older clients.
const base: SyncState = { tick: 5, localCount: 10, lastLocalCount: 10, remoteSeq: 7, lastRemoteSeq: 7 };

test("needsFullSync: a quiet tick skips (marker + local count unchanged)", () => {
  expect(needsFullSync(base, 30)).toBe(false);
});

test("needsFullSync: the first pass always bootstraps", () => {
  expect(needsFullSync({ ...base, tick: 1 }, 30)).toBe(true);
});

test("needsFullSync: the periodic safety net fires every fullEvery ticks; 0 disables it", () => {
  expect(needsFullSync({ ...base, tick: 30 }, 30)).toBe(true);
  expect(needsFullSync({ ...base, tick: 30 }, 0)).toBe(false); // 0 = trust the marker only
});

test("needsFullSync: a local row to push forces a pass", () => {
  expect(needsFullSync({ ...base, localCount: 11 }, 30)).toBe(true);
});

test("needsFullSync: a moved remote marker forces a pull", () => {
  expect(needsFullSync({ ...base, remoteSeq: 8 }, 30)).toBe(true);
});

test("needsFullSync: an absent marker is treated as changed (safe default)", () => {
  expect(needsFullSync({ ...base, remoteSeq: null }, 30)).toBe(true);
});
