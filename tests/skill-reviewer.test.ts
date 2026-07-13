import { test, expect, beforeEach } from "bun:test";
import { readFileSync } from "node:fs";
import { fromCapture } from "../src/skill/reviewer";
import { db } from "../src/core/db";

beforeEach(() => {
  try { db().run("DELETE FROM skills"); } catch { /* not created yet */ }
  try { db().run("DELETE FROM skill_runs"); } catch { /* not created yet */ }
});

test("learner prompt never adds reviewer subagents by default", () => {
  const prompt = readFileSync(
    new URL("../src/skill/prompts/learn-system.md", import.meta.url),
    "utf8",
  );
  expect(prompt).toContain("Reviewer spawning is not a default quality method");
  expect(prompt).not.toContain("or add a subagent reviewer");
});

test("fromCapture accepts a complete labeled submission, splitting master from explanation", () => {
  const r = fromCapture('{"label":"haiku","score":0.8,"right":"a","wrong":"b","improve":"c","master":"1. step","explanation":"why the best runs win"}');
  expect(r).toMatchObject({ label: "haiku", master: "1. step", explanation: "why the best runs win" });
  expect(r!.review?.score).toBe(0.8);
  expect(r!.failed).toBeFalsy();
});

test("fromCapture takes the loop's forced label even when the submission omits one", () => {
  // The learner no longer echoes a label; the loop supplies it. A complete review with no label field is kept.
  const r = fromCapture('{"score":0.8,"right":"a","wrong":"b","improve":"c","master":"1. step","explanation":"why"}', "haiku");
  expect(r).toMatchObject({ label: "haiku", master: "1. step", explanation: "why" });
  expect(r!.review?.score).toBe(0.8);
  expect(r!.failed).toBeFalsy();
});

test("fromCapture's forced label overrides any label the model strayed into", () => {
  const r = fromCapture('{"label":"poem","score":0.8,"right":"a","wrong":"b","improve":"c","master":"1. step","explanation":"why"}', "haiku");
  expect(r!.label).toBe("haiku"); // the loop's decision wins, never the model's
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
