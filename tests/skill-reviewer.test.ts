import { test, expect, beforeEach } from "bun:test";
import { parseReview, parseLearn, fromCapture } from "../src/skill/reviewer";
import { db } from "../src/core/db";

beforeEach(() => {
  try { db().run("DELETE FROM skills"); } catch { /* not created yet */ }
  try { db().run("DELETE FROM skill_runs"); } catch { /* not created yet */ }
});

test("parseReview accepts a full verdict", () => {
  const r = parseReview('{"score":0.8,"right":"vivid imagery","wrong":"flat ending","improve":"sharpen line 3"}');
  expect(r).toMatchObject({ score: 0.8, right: "vivid imagery", wrong: "flat ending", improve: "sharpen line 3" });
});

test("parseReview extracts from surrounding prose", () => {
  expect(parseReview('Here is my review:\n{"score":0.5,"right":"a","wrong":"b","improve":"c"}\nthanks')?.score).toBe(0.5);
});

test("parseReview rejects out-of-range score and junk", () => {
  expect(parseReview('{"score":1.5,"right":"x"}')).toBeNull();
  expect(parseReview("no json here")).toBeNull();
  expect(parseReview(null)).toBeNull();
});

test("parseLearn splits the verdict JSON from the rewritten master", () => {
  const raw = '{"score":0.8,"right":"a","wrong":"b","improve":"c"}\n===MASTER===\nBecause the best runs did X.\n\n1. step one\n2. step two';
  const { review, master } = parseLearn(raw);
  expect(review?.score).toBe(0.8);
  expect(master).toContain("1. step one");
  expect(master).not.toContain("score"); // the verdict JSON is not bleed into the master
});

test("parseLearn handles a response with no master section", () => {
  const { review, master } = parseLearn('{"score":0.5,"right":"","wrong":"","improve":""}');
  expect(review?.score).toBe(0.5);
  expect(master).toBeNull();
});

test("fromCapture accepts a complete labeled submission, splitting master from explanation", () => {
  const r = fromCapture('{"label":"haiku","score":0.8,"right":"a","wrong":"b","improve":"c","master":"1. step","explanation":"why the best runs win"}');
  expect(r).toMatchObject({ label: "haiku", master: "1. step", explanation: "why the best runs win" });
  expect(r!.review?.score).toBe(0.8);
  expect(r!.failed).toBeFalsy();
});

test("fromCapture HARD-fails a labeled submission missing the master", () => {
  const r = fromCapture('{"label":"haiku","score":0.8,"right":"a","wrong":"b","improve":"c","master":"","explanation":"why"}');
  expect(r!.failed).toBe(true);
  expect(r!.error).toMatch(/incomplete/i);
  expect(r!.label).toBeNull(); // not accepted as a partial result
});

test("fromCapture HARD-fails a labeled submission missing the explanation", () => {
  const r = fromCapture('{"label":"haiku","score":0.8,"right":"a","wrong":"b","improve":"c","master":"1. step","explanation":""}');
  expect(r!.failed).toBe(true);
  expect(r!.error).toMatch(/incomplete/i);
  expect(r!.label).toBeNull();
});

test("fromCapture HARD-fails a labeled submission with an out-of-range score", () => {
  const r = fromCapture('{"label":"haiku","score":2,"right":"a","wrong":"b","improve":"c","master":"why\\n\\n1. step"}');
  expect(r!.failed).toBe(true);
});

test("fromCapture treats an empty label as a clean non-task, not a failure", () => {
  const r = fromCapture('{"label":"","score":0,"right":"","wrong":"","improve":"","master":""}');
  expect(r).toMatchObject({ label: null, review: null, master: null });
  expect(r!.failed).toBeFalsy();
});

test("fromCapture flags non-JSON capture as a failure, never silently null", () => {
  const r = fromCapture("not json at all");
  expect(r!.failed).toBe(true);
  expect(r!.error).toMatch(/not valid json/i);
});

test("fromCapture returns null only when there is nothing to read", () => {
  expect(fromCapture("")).toBeNull();
  expect(fromCapture(null)).toBeNull();
});
