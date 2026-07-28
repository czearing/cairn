import { skillResultId, skillResultIds, skillResultNoMatch } from "./tool-result";
import { lifecycleScope, readLifecycle, resetLifecycle, updateLifecycle } from "./lifecycle";

interface TurnState {
  selected: boolean;
  pendingReviewIds: string[];
  reminded: boolean;
  turnSeq: number;
  cairnToolObserved: boolean;
  invalidatedSkillIds: string[];
  skillCorrectionNudges: number;
}
const scope = (session: string) => lifecycleScope("claude", session);

// A new user turn: clear the latch so the one reminder can fire again this turn.
export function resetSkillTurn(session: string): void { resetLifecycle(scope(session)); }

export function noteSkillSelection(session: string, tool: string, input: Record<string, unknown>, output?: unknown): void {
  const native = baseName(tool).toLowerCase() === "skill";
  let ids: string[] = [];
  if (baseName(tool) === "skill_select" && Array.isArray(input.ids)) {
    const requested = input.ids.filter((id): id is string => typeof id === "string" && id.trim().length > 0);
    const noMatch = skillResultNoMatch(output)
      || (requested.length === 1 && requested[0]!.toLowerCase() === "none");
    ids = noMatch ? [] : skillResultIds(output);
    if (!ids.length && !noMatch) {
      ids = requested;
    }
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
    selectedSkillIds: [...new Set([...state.selectedSkillIds, ...ids.filter((id) => !id.startsWith("__"))])],
    pendingReviewIds: [...new Set([...state.pendingReviewIds, ...ids])],
  }));
}

export function noteFailedSkillExecution(session: string): boolean {
  let required = false;
  updateLifecycle(scope(session), (state) => {
    const invalidated = [...new Set([...state.invalidatedSkillIds, ...state.selectedSkillIds])];
    required = invalidated.length > state.invalidatedSkillIds.length;
    return { ...state, invalidatedSkillIds: invalidated };
  });
  return required;
}

export function noteSkillEdit(session: string, id: string, succeeded: boolean): boolean {
  if (!succeeded || !id.trim()) return false;
  let resolved = false;
  updateLifecycle(scope(session), (state) => {
    const wasInvalidated = state.invalidatedSkillIds.includes(id.trim());
    const remaining = state.invalidatedSkillIds.filter((skillId) => skillId !== id.trim());
    resolved = wasInvalidated && remaining.length === 0;
    return {
      ...state,
      invalidatedSkillIds: remaining,
    };
  });
  return resolved;
}

export function noteSkillCorrectionNudge(session: string): void {
  updateLifecycle(scope(session), (state) => ({
    ...state,
    skillCorrectionNudges: state.skillCorrectionNudges + 1,
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
    invalidatedSkillIds: state.invalidatedSkillIds,
    skillCorrectionNudges: state.skillCorrectionNudges,
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
export function isSkillEdit(tool: string): boolean { return baseName(tool) === "skill_edit"; }
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
