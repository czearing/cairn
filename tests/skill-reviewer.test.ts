import { test, expect, beforeEach } from "bun:test";
import { parseReview, assembleMaster } from "../src/skill/reviewer";
import { buildArgs } from "../src/skill/claude";
import { putSkill, hasSession, markSession } from "../src/skill/store";
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

test("buildArgs starts a session with --session-id", () => {
  const a = buildArgs({ sessionId: "S1" });
  expect(a[a.indexOf("--session-id") + 1]).toBe("S1");
  expect(a).not.toContain("--resume");
});

test("buildArgs resumes with --resume, which takes precedence over sessionId", () => {
  const a = buildArgs({ sessionId: "S1", resume: "S1" });
  expect(a[a.indexOf("--resume") + 1]).toBe("S1");
  expect(a).not.toContain("--session-id");
});

test("session flag flips from start to resume", () => {
  putSkill({ id: "sk", task: "haiku", masterPrompt: "", ts: 1 }, [1, 0]);
  expect(hasSession("sk")).toBe(false);   // first review starts the session
  markSession("sk");
  expect(hasSession("sk")).toBe(true);    // later reviews resume it
});

test("assembleMaster returns null with no prior runs and never spawns", async () => {
  putSkill({ id: "empty", task: "haiku", masterPrompt: "", ts: 1 }, [1, 0]);
  expect(await assembleMaster("empty", "haiku")).toBeNull(); // returns before any CLI call
});
