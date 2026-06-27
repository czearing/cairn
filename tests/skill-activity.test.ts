import { test, expect, beforeEach, afterEach } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { existsSync, rmSync, readFileSync } from "node:fs";
import { recordActivity, readActivity, renderActivity, activityPath } from "../src/skill/activity";

let prev: string | undefined;
let path: string;

beforeEach(() => {
  prev = process.env.CAIRN_ACTIVITY_PATH;
  path = join(tmpdir(), `cairn-activity-${randomUUID()}.jsonl`);
  process.env.CAIRN_ACTIVITY_PATH = path;
});
afterEach(() => {
  if (prev === undefined) delete process.env.CAIRN_ACTIVITY_PATH; else process.env.CAIRN_ACTIVITY_PATH = prev;
  try { if (existsSync(path)) rmSync(path); } catch { /* ignore */ }
});

test("activityPath honors the env override", () => {
  expect(activityPath()).toBe(path);
});

test("record then read round-trips events in order", () => {
  recordActivity({ ts: 1, phase: "start", request: "write a haiku" });
  recordActivity({ ts: 2, phase: "learned", label: "haiku", score: 0.38, created: true, master: true });
  const got = readActivity();
  expect(got.map((e) => e.phase)).toEqual(["start", "learned"]);
  expect(got[1]).toMatchObject({ label: "haiku", score: 0.38, created: true, master: true });
});

test("readActivity is empty (not throwing) when the log does not exist", () => {
  expect(readActivity()).toEqual([]);
});

test("a torn (half-written) line is skipped, not fatal", () => {
  recordActivity({ ts: 1, phase: "skipped" });
  Bun.spawnSync(["bash", "-c", `printf '{not json\\n' >> "${path}"`]); // simulate a partial append
  recordActivity({ ts: 2, phase: "learned", label: "sql query", score: 0.9 });
  const got = readActivity();
  expect(got.map((e) => e.phase)).toEqual(["skipped", "learned"]); // the junk line is dropped
});

test("the log stays bounded under many events", () => {
  for (let i = 0; i < 600; i++) recordActivity({ ts: i, phase: "skipped" });
  const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
  expect(lines.length).toBeLessThanOrEqual(450); // trimmed, never unbounded
  expect(readActivity().at(-1)).toMatchObject({ ts: 599 }); // newest is always kept
});

test("renderActivity shows the request for a start event", () => {
  const s = renderActivity({ ts: 0, phase: "start", request: "write a haiku about the first frost" });
  expect(s).toContain("reviewing");
  expect(s).toContain("first frost");
});

test("renderActivity shows the label and score for a learned event", () => {
  const s = renderActivity({ ts: 0, phase: "learned", label: "haiku", score: 0.38, master: true });
  expect(s).toContain("haiku");
  expect(s).toContain("0.38");
  expect(s).toContain("master rewritten");
});

test("renderActivity marks a non-task as skipped", () => {
  expect(renderActivity({ ts: 0, phase: "skipped" })).toContain("skipped");
});
