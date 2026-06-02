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
