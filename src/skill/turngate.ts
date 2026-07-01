import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

// Per-turn latch for the "search your skills first" reminder. Hooks are separate short-lived processes, so the
// only shared state is on disk: one tiny JSON file per session. resetSkillTurn clears it at the start of each
// user turn; noteSkillSearched records that the agent called skill_search; claimSkillReminder arms the SINGLE
// reminder the first time the agent acts without having searched. Best-effort, never throws.

const DIR = () => process.env.CAIRN_SKILL_TURN_DIR || join(homedir(), ".cairn", "skill-turn");
const fileFor = (session: string) => join(DIR(), `${session.split("/").join("_").split("\\").join("_") || "default"}.json`);

interface TurnState { searched: boolean; reminded: boolean }
function readState(session: string): TurnState {
  try { return JSON.parse(readFileSync(fileFor(session), "utf8")) as TurnState; } catch { return { searched: false, reminded: false }; }
}
function writeState(session: string, s: TurnState): void {
  try { mkdirSync(DIR(), { recursive: true }); writeFileSync(fileFor(session), JSON.stringify(s)); } catch { /* best-effort */ }
}

// A new user turn: clear the latch so the one reminder can fire again this turn.
export function resetSkillTurn(session: string): void { writeState(session, { searched: false, reminded: false }); }

// The agent called skill_search this turn: record it so the reminder never fires.
export function noteSkillSearched(session: string): void { const s = readState(session); if (!s.searched) writeState(session, { ...s, searched: true }); }

// Tools that DO or CHANGE something, as opposed to reading/searching or brain bookkeeping. The reminder fires
// before the FIRST of these in a turn. This is a category of tool (does it act on the world), not a content
// heuristic about the task.
const ACTION_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit", "Bash", "Task"]);
const baseName = (tool: string) => (tool.includes("__") ? tool.slice(tool.lastIndexOf("__") + 2) : tool);
export function isActionTool(tool: string): boolean { return ACTION_TOOLS.has(baseName(tool)); }
export function isSkillSearch(tool: string): boolean { return baseName(tool) === "skill_search"; }
export function isSkillReview(tool: string): boolean { return baseName(tool) === "skill_review"; }

// True (and arms the latch so it never returns true again this turn) only the first time the agent is about to
// act without having searched its skills. Returns false once it has searched, or after the one reminder.
export function claimSkillReminder(session: string): boolean {
  const s = readState(session);
  if (s.searched || s.reminded) return false;
  writeState(session, { ...s, reminded: true });
  return true;
}
