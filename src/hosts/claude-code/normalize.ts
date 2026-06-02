import type { NormalizedEvent } from "../../inject/events.types";
import { brainUsedThisTurn } from "./transcript";

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

// Convert a Claude Code hook payload into the host-agnostic event shape. Returns null for
// events we don't care about — the dispatcher uses that as the cue to exit 0 immediately.
export async function normalizeClaudeCode(payload: unknown): Promise<NormalizedEvent | null> {
  if (!isObject(payload)) return null;
  const eventName = payload.hook_event_name;

  if (eventName === "UserPromptSubmit") {
    const text = payload.prompt;
    return typeof text === "string" ? { kind: "user_message", text } : null;
  }

  if (eventName === "PostToolUse") {
    const tool = payload.tool_name;
    const input = payload.tool_input;
    if (typeof tool !== "string" || !isObject(input)) return null;
    // Docs name this `tool_output`; older payloads used `tool_response`. Accept both.
    const output = payload.tool_output ?? payload.tool_response;
    return { kind: "tool_completed", tool, input, output };
  }

  if (eventName === "Stop") {
    // stop_hook_active means we already nudged once this turn — don't loop.
    if (payload.stop_hook_active) return null;
    const tp = payload.transcript_path;
    if (typeof tp !== "string") return null;
    return { kind: "turn_finished", usedBrain: await brainUsedThisTurn(tp) };
  }

  return null;
}

// Read which hook event this payload came from, for echoing back in the response.
export function getEventName(payload: unknown): string | null {
  if (!isObject(payload)) return null;
  const name = payload.hook_event_name;
  return typeof name === "string" ? name : null;
}
