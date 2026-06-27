import { test, expect } from "bun:test";
import { sidecarPort } from "../src/core/embed";

const M = "Xenova/all-MiniLM-L6-v2";

test("sidecarPort accepts a same-model lockfile", () => {
  expect(sidecarPort(JSON.stringify({ port: 5123, pid: 1, model: M }), M)).toBe(5123);
});

test("sidecarPort REJECTS a different-model sidecar (stale-model bug guard)", () => {
  expect(sidecarPort(JSON.stringify({ port: 5123, pid: 1, model: "other-model" }), M)).toBeNull();
});

test("sidecarPort rejects a lockfile with no model (pre-stamp / legacy)", () => {
  expect(sidecarPort(JSON.stringify({ port: 5123, pid: 1 }), M)).toBeNull();
});

test("sidecarPort rejects junk and missing port", () => {
  expect(sidecarPort("not json", M)).toBeNull();
  expect(sidecarPort(JSON.stringify({ model: M }), M)).toBeNull();
});
