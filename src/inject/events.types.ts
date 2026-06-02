/**
 * Host-agnostic event shape. Every agent host (Claude Code, Cursor, Aider, …) normalizes its
 * raw hook payload into one of these before the dispatcher runs. Adding a new event kind here
 * is the only place the core needs to change.
 */
export type NormalizedEvent =
  | { kind: "user_message"; text: string }
  | {
      kind: "tool_completed";
      tool: string;
      input: Record<string, unknown>;
      output: unknown;
    };
