// Shapes the hook's stdout for each event — i.e. HOW the injected prompt is delivered at each
// moment. This is the timing contract, kept pure so it can be tested (see hook.test.ts):
//   PreToolUse  → injected as context alongside an `allow` (fires before the write)
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
