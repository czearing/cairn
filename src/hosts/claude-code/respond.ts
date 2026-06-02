// Shapes the hook's stdout for each moment — the timing contract, kept pure so it can be
// tested (see hook.test.ts):
//   Stop        → `decision: block` forces the agent to continue
//   everything  → plain additionalContext
export function respond(eventName: string, content: string): object {
  if (eventName === "Stop") return { decision: "block", reason: content };
  return { hookSpecificOutput: { hookEventName: eventName, additionalContext: content } };
}

// Reject a pending tool call BEFORE it runs (PreToolUse), feeding the reason back to the model
// so it re-issues a compliant call. This is what enforces the entry format on the actual write.
export function denyPreTool(reason: string): object {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  };
}
