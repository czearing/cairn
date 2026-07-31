// Shared primitives for the host transcript extractors (Claude Code: transcript.ts, Copilot CLI:
// transcript-copilot.ts). The two hosts store events in different shapes, so the turn-scoping helper is
// generic over the event type with its predicate injected.

/** One human turn reduced to what the skill-receipt check needs: the ask, the deliverable, and the process. */
export interface RunInput { request: string; transcript: string; output: string }

export const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

// Host tool names arrive namespaced ("mcp__cairn__skill_select", "cairn-skill_select"). Reduce to the bare name.
export const normalizedTool = (name: string): string =>
  name.includes("__") ? name.slice(name.lastIndexOf("__") + 2) : name.replace(/^cairn-/, "");

// The short human label a tool call carries, used to name skill rows in the rendered transcript. Args arrive as
// either a JSON string or an already-parsed object depending on the host.
export function hintFrom(raw: unknown): string {
  let o: { title?: unknown; label?: unknown; task?: unknown; query?: unknown; what?: unknown; id?: unknown };
  try {
    o = typeof raw === "string" ? JSON.parse(raw) : ((raw ?? {}) as typeof o);
  } catch {
    return "";
  }
  if (!o || typeof o !== "object") return "";
  return str(o.title) || str(o.label) || str(o.task) || str(o.query) || str(o.what) || str(o.id);
}

// Index where the latest human turn begins: the run of consecutive human messages closest to the end. Returns
// -1 when the log holds no genuine human message.
export function latestTurnRange<E>(events: readonly E[], genuineUser: (event: E) => boolean): number {
  const lastUser = events.findLastIndex(genuineUser);
  if (lastUser < 0) return -1;
  let start = lastUser;
  while (start > 0 && genuineUser(events[start - 1]!)) start--;
  return start;
}
