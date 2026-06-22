import { test, expect } from "bun:test";
import { decideSync, type SyncInputs } from "../src/core/sync";

// The per-tick decision that keeps cloud sync O(delta): skip on a single marker read when nothing
// changed, run the cheap cursor path on a real change, and fall back to the full backstop only on the
// first pass / periodic safety net / an un-provisioned marker.
const base: SyncInputs = { tick: 5, fullEvery: 30, remoteSeq: 7, lastRemoteSeq: 7, localMaxRowid: 100, pushCursor: 100 };

test("decideSync: skips when the marker and the push cursor are both unchanged", () => {
  expect(decideSync(base)).toBe("skip");
});

test("decideSync: the first pass bootstraps with a full reconcile", () => {
  expect(decideSync({ ...base, tick: 1 })).toBe("full");
});

test("decideSync: the periodic backstop forces a full pass; fullEvery=0 disables it", () => {
  expect(decideSync({ ...base, tick: 30 })).toBe("full");
  expect(decideSync({ ...base, tick: 30, fullEvery: 0 })).toBe("skip");
});

test("decideSync: a moved remote marker takes the fast (cursor) path", () => {
  expect(decideSync({ ...base, remoteSeq: 8 })).toBe("fast");
});

test("decideSync: unpushed local rows (max rowid past the push cursor) take the fast path", () => {
  expect(decideSync({ ...base, localMaxRowid: 105 })).toBe("fast");
});

test("decideSync: an absent/unreadable marker falls back to the full backstop", () => {
  expect(decideSync({ ...base, remoteSeq: null })).toBe("full");
});
