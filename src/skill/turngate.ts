import { skillResultId } from "./tool-result";
import { lifecycleScope, readLifecycle, resetLifecycle, updateLifecycle } from "./lifecycle";

interface TurnState {
  selected: boolean;
  pendingReviewIds: string[];
  reminded: boolean;
  turnSeq: number;
  cairnToolObserved: boolean;
}
const scope = (session: string) => lifecycleScope("claude", session);

// A new user turn: clear the latch so the one reminder can fire again this turn.
export function resetSkillTurn(session: string): void { resetLifecycle(scope(session)); }

export function noteSkillSelection(session: string, tool: string, input: Record<string, unknown>, output?: unknown): void {
  const native = baseName(tool).toLowerCase() === "skill";
  let ids: string[] = [];
  if (baseName(tool) === "skill_select" && Array.isArray(input.ids)) {
    ids = input.ids.filter((id): id is string => typeof id === "string" && id.trim().length > 0);
  } else if (baseName(tool) === "skill_create") {
    ids = [skillResultId(output) || "__created__"];
  } else if (baseName(tool) === "skill_search") {
    ids = ["__legacy__"];
  }
  updateLifecycle(scope(session), (state) => ({
    ...state,
    skillUsed: true,
    cairnToolAttempted: state.cairnToolAttempted || !native,
    cairnToolObserved: state.cairnToolObserved || !native,
    pendingReviewIds: [...new Set([...state.pendingReviewIds, ...ids])],
  }));
}

export function noteCairnToolObserved(session: string): void {
  updateLifecycle(scope(session), (state) => ({
    ...state,
    cairnToolAttempted: true,
    cairnToolObserved: true,
  }));
}

export function noteSkillReviewed(session: string, id: string): void {
  updateLifecycle(scope(session), (state) => ({
    ...state,
    pendingReviewIds: state.pendingReviewIds.filter((pendingId) =>
      pendingId !== id && pendingId !== "__created__" && pendingId !== "__legacy__"
    ),
  }));
}

export function noteLegacySkillReview(session: string, id: string): void {
  updateLifecycle(scope(session), (state) => ({
    ...state,
    skillUsed: true,
    pendingReviewIds: [...new Set([
      ...state.pendingReviewIds.filter((pendingId) => pendingId !== "__created__" && pendingId !== "__legacy__"),
      id,
    ])],
  }));
}

export function skillTurnState(session: string): TurnState {
  const state = readLifecycle(scope(session));
  return {
    selected: state.skillUsed,
    pendingReviewIds: state.pendingReviewIds,
    reminded: state.reminded,
    turnSeq: state.turnSeq,
    cairnToolObserved: state.cairnToolObserved,
  };
}

// Tools that DO or CHANGE something, as opposed to reading/searching or brain bookkeeping. The reminder fires
// before the FIRST of these in a turn. This is a category of tool (does it act on the world), not a content
// heuristic about the task.
const ACTION_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit", "Bash", "Task"]);
const baseName = (tool: string) => (tool.includes("__") ? tool.slice(tool.lastIndexOf("__") + 2) : tool);
export function isActionTool(tool: string): boolean { return ACTION_TOOLS.has(baseName(tool)); }
export function isSkillSelection(tool: string): boolean {
  return ["skill", "skill_select", "skill_create", "skill_search"].includes(baseName(tool).toLowerCase());
}
export function isSkillReview(tool: string): boolean { return baseName(tool) === "skill_review"; }
export function isCairnTool(tool: string): boolean {
  const name = baseName(tool).toLowerCase();
  return name.startsWith("brain_") || name.startsWith("skill_");
}

// True (and arms the latch so it never returns true again this turn) only the first time the agent is about to
// act without selecting or creating a skill. Returns false once prepared, or after the one reminder.
export function claimSkillReminder(session: string): boolean {
  let claimed = false;
  updateLifecycle(scope(session), (state) => {
    if (state.skillUsed || state.reminded) return state;
    claimed = true;
    return { ...state, reminded: true };
  });
  return claimed;
}
