import { test, expect, beforeEach } from "bun:test";
import { rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { resetSkillTurn, noteSkillSearched, claimSkillReminder, isActionTool, isSkillSearch } from "../src/skill/turngate";

const DIR = join(tmpdir(), `cairn-turn-${randomUUID()}`);
beforeEach(() => {
  process.env.CAIRN_SKILL_TURN_DIR = DIR;
  try { rmSync(DIR, { recursive: true, force: true }); } catch { /* none */ }
  mkdirSync(DIR, { recursive: true });
});

test("the reminder fires exactly once per turn when the agent acts before searching", () => {
  resetSkillTurn("S");
  expect(claimSkillReminder("S")).toBe(true);   // first action without a search -> remind
  expect(claimSkillReminder("S")).toBe(false);  // already reminded this turn -> silent
  expect(claimSkillReminder("S")).toBe(false);
});

test("searching first suppresses the reminder entirely", () => {
  resetSkillTurn("S");
  noteSkillSearched("S");                        // agent called skill_search
  expect(claimSkillReminder("S")).toBe(false);   // so it is never reminded
});

test("a new turn re-arms the one reminder", () => {
  resetSkillTurn("S");
  expect(claimSkillReminder("S")).toBe(true);
  expect(claimSkillReminder("S")).toBe(false);
  resetSkillTurn("S");                           // next user message
  expect(claimSkillReminder("S")).toBe(true);    // armed again
});

test("turn state is per-session", () => {
  resetSkillTurn("A"); resetSkillTurn("B");
  noteSkillSearched("A");
  expect(claimSkillReminder("A")).toBe(false);   // A searched
  expect(claimSkillReminder("B")).toBe(true);    // B did not
});

test("action tools are the ones that act; searches and reads are not", () => {
  expect(isActionTool("Edit")).toBe(true);
  expect(isActionTool("Bash")).toBe(true);
  expect(isActionTool("Task")).toBe(true);
  expect(isActionTool("Read")).toBe(false);
  expect(isActionTool("brain_search")).toBe(false);
  expect(isActionTool("mcp__cairn__skill_search")).toBe(false);
  expect(isSkillSearch("mcp__cairn__skill_search")).toBe(true);   // namespaced MCP name resolves
  expect(isSkillSearch("skill_search")).toBe(true);
  expect(isSkillSearch("brain_search")).toBe(false);
});
