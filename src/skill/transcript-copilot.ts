import { readFileSync } from "node:fs";
import type { RunInput } from "./pipeline";
import { isSystemEnvelope } from "./noise";

// Extract a RunInput for the CURRENT turn from a GitHub Copilot CLI transcript. Copilot writes one JSON event
// per line to ~/.copilot/session-state/<id>/events.jsonl, a DIFFERENT shape from Claude's message-JSONL (see
// transcript.ts). The events we grade with: `user.message` (data.content = the human's prompt), `assistant.
// message` (data.content = the agent's text), and `tool.execution_start` (data.toolName = an action). We scope
// to the latest turn (everything from the last user.message on) so an earlier task in the same session is not
// mis-attributed, and join all of the turn's assistant text so a deliverable produced mid-turn is never lost.

interface Event { role: "user" | "assistant"; text: string; tool?: string }

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

export function extractRunCopilot(path: string): RunInput | null {
  let lines: string[];
  try { lines = readFileSync(path, "utf8").split("\n").filter(Boolean); } catch { return null; }

  const events: Event[] = [];
  for (const line of lines) {
    let o: { type?: string; data?: { content?: unknown; toolName?: unknown } };
    try { o = JSON.parse(line); } catch { continue; }
    const data = o.data ?? {};
    if (o.type === "user.message") { const t = str(data.content); if (t) events.push({ role: "user", text: t }); }
    else if (o.type === "assistant.message") { const t = str(data.content); if (t) events.push({ role: "assistant", text: t }); }
    else if (o.type === "tool.execution_start") { const n = str(data.toolName); if (n) events.push({ role: "assistant", text: "", tool: n }); }
  }
  if (events.length === 0) return null;

  // Scope to the current turn: everything from the LAST GENUINE human prompt onward. A host system-envelope
  // user.message (a <task-notification>, a <system_reminder>, a skill-context preamble, a slash-command frame)
  // is the harness talking, not the user, so it never anchors a turn — otherwise the loop would grade whatever
  // the agent did in response and mint a skill from a notification. If the turn has no genuine human prompt at
  // all, there is nothing to learn.
  let start = -1;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.role === "user" && e.text && !isSystemEnvelope(e.text)) { start = i; break; }
  }
  if (start < 0) return null;
  const turn = events.slice(start);

  const request = turn.filter((e) => e.role === "user" && e.text && !isSystemEnvelope(e.text)).map((e) => e.text).join("\n").trim();
  const output = turn.filter((e) => e.role === "assistant" && e.text).map((e) => e.text).join("\n\n").trim();
  if (!request || !output) return null;

  // Process = the whole turn in order, with tool calls inline, so the learner sees what actually happened
  // (which skills it searched, when it spawned a subagent). No length cap here — runCopilot caps the final
  // prompt if needed, dropping the transcript middle, never the deliverable.
  const transcript = turn
    .map((e) => (e.tool ? `[tool] ${e.tool}` : `[${e.role}] ${e.text}`))
    .join("\n");
  return { request, transcript, output };
}
