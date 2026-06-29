// Shapes the hook's stdout for each moment — the timing contract, kept pure so it can be
// tested (see hook.test.ts):
//   PreToolUse  → inject context alongside an `allow` (fires when the tool is called; never
//                 rejects). Claude delivers this context to the model after the tool returns.
//   Stop        → `decision: block` forces the agent to continue
//   everything  → plain additionalContext
export function respond(eventName: string, content: string): object {
  if (eventName === "Stop") return { decision: "block", reason: content };
  if (eventName === "PreToolUse") {
    return {
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", additionalContext: content },
    };
  }
  return { hookSpecificOutput: { hookEventName: eventName, additionalContext: content } };
}

// Rewrite a pending tool's input (PreToolUse). `updatedInput` REPLACES the original tool input before the
// tool runs, so a Task spawn can receive a modified `prompt` (this is the only channel that injects context
// into a subagent's own window, since SessionStart does not fire for subagents). additionalContext, when set,
// also goes back to the parent. Allows the call.
export function modifyPreTool(updatedInput: object, additionalContext = ""): object {
  const out: Record<string, unknown> = { hookEventName: "PreToolUse", permissionDecision: "allow", updatedInput };
  if (additionalContext) out.additionalContext = additionalContext;
  return { hookSpecificOutput: out };
}

// Block a pending tool call (PreToolUse), feeding the reason back so the agent reconsiders.
export function denyPreTool(reason: string): object {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  };
}
