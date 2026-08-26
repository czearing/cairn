import type { NormalizedEvent } from "./events.types";
import type { Match } from "./matchers.types";

// Conditional injection policy. Pure data + a small switch — no I/O.
// To add a new trigger: add a case here and drop a .md file in prompts/.

// MCP tools arrive as "mcp__<server>__<tool>". Accept both bare and namespaced names.
function isTool(tool: string, name: string): boolean {
  return tool === name || tool.endsWith(`__${name}`);
}

export function matchEvent(event: NormalizedEvent): Match {
  if (event.kind === "user_message") {
    return { promptFile: (event.turnSeq && event.turnSeq > 1) ? "workflow-reminder.md" : "user-message.md" };
  }
  if (event.kind === "turn_finished") {
    if (!event.usedBrain) return { promptFile: "turn-reminder.md" };
    return null;
  }

  if (event.kind === "tool_pending") {
    return null;
  }

  const { tool } = event;
  if (isTool(tool, "brain_search")) return { promptFile: "search-results.md" };
  if (isTool(tool, "brain_create")) return { promptFile: "node-created.md" };
  if (isTool(tool, "brain_mutate")) return null;

  return null;
}
