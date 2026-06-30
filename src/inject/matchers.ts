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
  if (event.kind === "turn_finished") {
    if (!event.usedBrain) return { promptFile: "turn-reminder.md" };
    return null;
  }

  // PreToolUse → remind before the action runs. A brain write gets the entry-format rules; a Task
  // spawn (and ONLY a Task spawn — no other tool) gets the orchestration protocol injected the moment
  // the agent reaches for subagents, so the user never has to remember to ask for disjoint,
  // brain-coordinated delegation.
  if (event.kind === "tool_pending") {
    if (isTool(event.tool, "brain_create") || isTool(event.tool, "brain_mutate")) return { promptFile: "entry-format.md" };
    if (event.tool === "Task" || event.tool === "Agent") return { promptFile: "orchestrate.md" };
    return null;
  }

  const { tool, input } = event;
  if (isTool(tool, "brain_search")) return { promptFile: "search-results.md" };
  if (isTool(tool, "brain_create")) return { promptFile: "node-created.md" };
  if (isTool(tool, "brain_mutate")) {
    // Setting an answer triggers the split-check; other edits are just modifications.
    return typeof input.answer === "string" && input.answer.trim()
      ? { promptFile: "answer-check.md" }
      : { promptFile: "node-modified.md" };
  }
  if (tool === "Task" || tool === "Agent") return { promptFile: "subtask-spawned.md" };

  return null;
}
