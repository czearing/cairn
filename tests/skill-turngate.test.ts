import { test, expect, beforeEach } from "bun:test";
import { rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { resetSkillTurn, noteSkillReviewed, noteSkillSelection, skillTurnState, claimSkillReminder, isActionTool, isSkillSelection } from "../src/skill/turngate";

const DIR = join(tmpdir(), `cairn-turn-${randomUUID()}`);
beforeEach(() => {
  process.env.CAIRN_SKILL_TURN_DIR = DIR;
  try { rmSync(DIR, { recursive: true, force: true }); } catch { /* none */ }
  mkdirSync(DIR, { recursive: true });
});

test("the reminder fires exactly once per turn when the agent acts before selecting", () => {
  resetSkillTurn("S");
  expect(claimSkillReminder("S")).toBe(true);   // first action without a search -> remind
  expect(claimSkillReminder("S")).toBe(false);  // already reminded this turn -> silent
  expect(claimSkillReminder("S")).toBe(false);
});

test("selecting first suppresses the reminder entirely", () => {
  resetSkillTurn("S");
  noteSkillSelection("S", "skill_select", { ids: ["a"] });
  expect(claimSkillReminder("S")).toBe(false);   // so it is never reminded
});

test("a new turn re-arms the one reminder", () => {
  resetSkillTurn("S");
  expect(claimSkillReminder("S")).toBe(true);
  expect(claimSkillReminder("S")).toBe(false);
  resetSkillTurn("S");                           // next user message
  expect(claimSkillReminder("S")).toBe(true);    // armed again
});

test("a turn that ended after selection is re-armed at the turn boundary", () => {
  // Regression: dispatch used to clear the latch ONLY on user_message. A resume after compaction fires no
  // user_message, so a searched=true latch from a prior turn stayed set and silently suppressed the reminder
  // for the rest of the session. The fix also clears the latch on turn_finished (Stop), modeled here.
  resetSkillTurn("S");
  noteSkillSelection("S", "skill_select", { ids: ["a"] });
  expect(claimSkillReminder("S")).toBe(false);
  resetSkillTurn("S");                           // turn boundary (turn_finished/Stop) clears the latch
  expect(claimSkillReminder("S")).toBe(true);    // resumed turn 2's first action re-arms despite no user_message
});

test("turn state is per-session", () => {
  resetSkillTurn("A"); resetSkillTurn("B");
  noteSkillSelection("A", "skill_select", { ids: ["a"] });
  expect(claimSkillReminder("A")).toBe(false);   // A searched
  expect(claimSkillReminder("B")).toBe(true);    // B did not
});

test("every selected skill remains pending until individually reviewed", () => {
  resetSkillTurn("S");
  noteSkillSelection("S", "skill_select", { ids: ["a", "b"] });
  expect(skillTurnState("S").pendingReviewIds).toEqual(["a", "b"]);
  noteSkillReviewed("S", "a");
  expect(skillTurnState("S").pendingReviewIds).toEqual(["b"]);
  noteSkillReviewed("S", "b");
  expect(skillTurnState("S").pendingReviewIds).toEqual([]);
});

test("created skill tracking uses the returned id and ignores unrelated reviews", () => {
  resetSkillTurn("S");
  noteSkillSelection("S", "skill_create", {}, { content: [{ text: '{"id":"created-skill"}' }] });
  expect(skillTurnState("S").pendingReviewIds).toEqual(["created-skill"]);
  noteSkillReviewed("S", "other-skill");
  expect(skillTurnState("S").pendingReviewIds).toEqual(["created-skill"]);
  noteSkillReviewed("S", "created-skill");
  expect(skillTurnState("S").pendingReviewIds).toEqual([]);
});

test("action tools are the ones that act; searches and reads are not", () => {
  expect(isActionTool("Edit")).toBe(true);
  expect(isActionTool("Bash")).toBe(true);
  expect(isActionTool("Task")).toBe(true);
  expect(isActionTool("Read")).toBe(false);
  expect(isActionTool("brain_search")).toBe(false);
  expect(isActionTool("mcp__cairn__skill_select")).toBe(false);
  expect(isSkillSelection("mcp__cairn__skill_select")).toBe(true);
  expect(isSkillSelection("skill_create")).toBe(true);
  expect(isSkillSelection("skill_search")).toBe(true); // legacy compatibility
  expect(isSkillSelection("Skill")).toBe(true); // host-native skill loader
  expect(isSkillSelection("brain_search")).toBe(false);
});

test("a host-native skill satisfies the turn gate without a Cairn review id", () => {
  resetSkillTurn("S");
  noteSkillSelection("S", "Skill", { skill: "cairn-harness" }, { ok: true });
  expect(skillTurnState("S")).toMatchObject({ selected: true, pendingReviewIds: [] });
  expect(claimSkillReminder("S")).toBe(false);
});
