import { test, expect, beforeEach } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { readPrefs, addPref, removePref, clearPrefs, prefsBlock } from "../src/core/prefs";
import { inject } from "../src/inject/inject";

// Each test gets a fresh temp prefs file so nothing leaks between tests or touches the real file.
beforeEach(() => { process.env.CAIRN_PREFS_PATH = join(tmpdir(), `cairn-prefs-${randomUUID()}.md`); });

test("prefs: empty by default; block is the empty string (a no-op injection)", () => {
  expect(readPrefs()).toEqual([]);
  expect(prefsBlock()).toBe("");
});

test("prefs: add, dedupe, read back in order", () => {
  addPref("no em dashes");
  addPref("be terse");
  addPref("no em dashes"); // duplicate ignored
  expect(readPrefs()).toEqual(["no em dashes", "be terse"]);
});

test("prefs: remove by 1-based index and by exact text", () => {
  addPref("a"); addPref("b"); addPref("c");
  removePref("2");
  expect(readPrefs()).toEqual(["a", "c"]);
  removePref("a");
  expect(readPrefs()).toEqual(["c"]);
});

test("prefs: clear empties the list and the file still parses to []", () => {
  addPref("x");
  clearPrefs();
  expect(readPrefs()).toEqual([]);
});

test("prefs: the # header line is never read as a preference", () => {
  addPref("real pref");
  expect(readPrefs()).toEqual(["real pref"]); // the header comment is filtered out
});

test("prefsBlock: bulleted, honor-every-response block", () => {
  addPref("no em dashes");
  addPref("be terse");
  const b = prefsBlock();
  expect(b).toContain("User preferences");
  expect(b).toContain("- no em dashes");
  expect(b).toContain("- be terse");
});

test("inject: preferences ride along on user_message ONLY", async () => {
  addPref("no em dashes");
  const onPrompt = await inject({ kind: "user_message", text: "hello" });
  expect(onPrompt).toContain("- no em dashes");
  // a tool-completed event must NOT carry the prefs — no per-action bloat
  const onTool = await inject({ kind: "tool_completed", tool: "brain_search", input: {}, output: [] });
  expect(onTool ?? "").not.toContain("no em dashes");
});

test("inject: with no prefs file, user_message injection is unchanged (no prefs block)", async () => {
  const onPrompt = await inject({ kind: "user_message", text: "hi" });
  expect(onPrompt).toBeTruthy();              // the per-turn workflow prompt still injects
  expect(onPrompt).not.toContain("User preferences");
});
