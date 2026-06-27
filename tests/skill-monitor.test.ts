import { test, expect, beforeEach, afterEach } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { existsSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { lockPath, monitorAlive, ensureMonitor } from "../src/skill/monitor";

let prevLock: string | undefined;
let prevOptOut: string | undefined;
let lock: string;

beforeEach(() => {
  prevLock = process.env.CAIRN_MONITOR_LOCK;
  prevOptOut = process.env.CAIRN_SKILLS_MONITOR;
  lock = join(tmpdir(), `cairn-monitor-${randomUUID()}.lock`);
  process.env.CAIRN_MONITOR_LOCK = lock;
});
afterEach(() => {
  if (prevLock === undefined) delete process.env.CAIRN_MONITOR_LOCK; else process.env.CAIRN_MONITOR_LOCK = prevLock;
  if (prevOptOut === undefined) delete process.env.CAIRN_SKILLS_MONITOR; else process.env.CAIRN_SKILLS_MONITOR = prevOptOut;
  try { if (existsSync(lock)) rmSync(lock); } catch { /* ignore */ }
});

test("lockPath honors the env override", () => {
  expect(lockPath()).toBe(lock);
});

test("no monitor is alive when the lock is missing", () => {
  expect(monitorAlive(1000)).toBe(false);
});

test("a live pid with a fresh heartbeat counts as alive", () => {
  writeFileSync(lock, JSON.stringify({ pid: process.pid, ts: 1000 })); // our own pid is alive
  expect(monitorAlive(1000)).toBe(true);
});

test("a fresh heartbeat goes stale past the window", () => {
  writeFileSync(lock, JSON.stringify({ pid: process.pid, ts: 1000 }));
  expect(monitorAlive(1000 + 19_000)).toBe(true);   // within the 20s window
  expect(monitorAlive(1000 + 21_000)).toBe(false);  // past it: dead
});

test("a dead pid is never alive even with a fresh heartbeat", () => {
  writeFileSync(lock, JSON.stringify({ pid: 2_000_000_000, ts: 5000 })); // a pid that isn't running
  expect(monitorAlive(5000)).toBe(false);
});

test("ensureMonitor does NOT open a second window when one is alive (singleton)", () => {
  const before = JSON.stringify({ pid: process.pid, ts: 9000 });
  writeFileSync(lock, before);
  expect(ensureMonitor(9000)).toBe(false);          // a healthy monitor already runs: no spawn
  expect(readFileSync(lock, "utf8")).toBe(before);  // lock untouched
});

test("ensureMonitor is a no-op when opted out via CAIRN_SKILLS_MONITOR=0", () => {
  process.env.CAIRN_SKILLS_MONITOR = "0";
  expect(ensureMonitor(1000)).toBe(false);
  expect(existsSync(lock)).toBe(false); // never even claimed the lock
});
