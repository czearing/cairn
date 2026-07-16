/**
 * Host-agnostic event shape. Every agent host (Claude Code, Cursor, Aider, …) normalizes its
 * raw hook payload into one of these before the dispatcher runs. Adding a new event kind here
 * is the only place the core needs to change.
 */
export type NormalizedEvent =
  | { kind: "user_message"; text: string }
  /** A tool is ABOUT to run (PreToolUse) — fires before the write hits the db. */
  | { kind: "tool_pending"; tool: string; input: Record<string, unknown>; callId?: string }
  | {
      kind: "tool_completed";
      tool: string;
      input: Record<string, unknown>;
      output: unknown;
      callId?: string;
    }
  /**
   * The agent finished a turn. `usedBrain` is whether it called brain_search/brain_mutate this turn.
   */
  | { kind: "turn_finished"; usedBrain: boolean };
