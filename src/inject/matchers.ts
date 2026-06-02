import type { NormalizedEvent } from "./events.types";
import type { Match } from "./matchers.types";

// Conditional injection policy. Pure data + a small switch — no I/O.
// To add a new trigger: add a case here and drop a .md file in prompts/.

// MCP tools arrive as "mcp__<server>__<tool>". Accept both bare and namespaced names.
function isTool(tool: string, name: string): boolean {
  return tool === name || tool.endsWith(`__${name}`);
}

export function matchEvent(event: NormalizedEvent): Match {
  if (event.kind === "user_message") return { promptFile: "user-message.md" };

  const { tool } = event;
  if (isTool(tool, "brain_search")) return { promptFile: "search-results.md" };
  if (isTool(tool, "brain_create")) return { promptFile: "node-created.md" };
  if (isTool(tool, "brain_mutate")) return { promptFile: "node-modified.md" };
  if (tool === "Task") return { promptFile: "subtask-spawned.md" };

  return null;
}
