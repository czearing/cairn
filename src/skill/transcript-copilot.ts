import { readFileSync } from "node:fs";
import type { RunInput } from "./pipeline";
import { isSystemEnvelope } from "./noise";

// Extract a RunInput for the CURRENT turn from a GitHub Copilot CLI transcript. Copilot writes one JSON event
// per line to ~/.copilot/session-state/<id>/events.jsonl, a DIFFERENT shape from Claude's message-JSONL (see
// transcript.ts). The events we grade with: `user.message` (data.content = the human's prompt), `assistant.
// message` (data.content = the agent's text), `tool.execution_start` (data.toolName = an action), and the
// `subagent.started` / `subagent.completed` pair. A SUBAGENT's own messages and tool calls are interleaved in
// THIS same log, tagged with an `agentId`, so the whole turn — including work a subagent produced — is here;
// we tag those lines so the reviewer can tell a subagent's deliverable (e.g. a story review) from the main
// agent's. We scope to the latest turn (everything from the last genuine human prompt on) and join all of the
// turn's assistant text (main AND subagent) so a deliverable produced by either is never lost.

interface Event { role: "user" | "assistant"; text: string; tool?: string; agent?: string; marker?: string }

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

export function extractRunCopilot(path: string): RunInput | null {
  let lines: string[];
  try { lines = readFileSync(path, "utf8").split("\n").filter(Boolean); } catch { return null; }

  const agentName = new Map<string, string>(); // agentId -> a short human name, learned from subagent.started
  const events: Event[] = [];
  for (const line of lines) {
    let o: { type?: string; agentId?: unknown; data?: { content?: unknown; toolName?: unknown; agentName?: unknown; agentDisplayName?: unknown } };
    try { o = JSON.parse(line); } catch { continue; }
    const data = o.data ?? {};
    const agentId = str(o.agentId);
    // A subagent's messages/tools carry an agentId; resolve it to the name captured at subagent.started.
    const agent = agentId ? (agentName.get(agentId) || "subagent") : undefined;

    if (o.type === "subagent.started") {
      const name = str(data.agentDisplayName) || str(data.agentName) || "subagent";
      if (agentId) agentName.set(agentId, name);
      events.push({ role: "assistant", text: "", marker: `↳ spawned subagent: ${name}` });
    } else if (o.type === "subagent.completed") {
      const name = (agentId && agentName.get(agentId)) || str(data.agentDisplayName) || str(data.agentName) || "subagent";
      events.push({ role: "assistant", text: "", marker: `↳ subagent ${name} returned` });
    } else if (o.type === "user.message") {
      const t = str(data.content); if (t) events.push({ role: "user", text: t });
    } else if (o.type === "assistant.message") {
      const t = str(data.content); if (t) events.push({ role: "assistant", text: t, agent });
    } else if (o.type === "tool.execution_start") {
      const n = str(data.toolName); if (n) events.push({ role: "assistant", text: "", tool: n, agent });
    }
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
  // Deliverable = ALL assistant text this turn, from the main agent AND any subagent (a story-writer subagent's
  // story, a reviewer subagent's critique), so nothing a subagent produced is lost. The segmenter splits them.
  const output = turn.filter((e) => e.role === "assistant" && e.text).map((e) => e.text).join("\n\n").trim();
  if (!request || !output) return null;

  // Process = the whole turn in order, subagent activity tagged inline, so the reviewer sees what actually
  // happened (which skills it searched, when it spawned a subagent, what that subagent produced). No length cap
  // here — runCopilot caps the final prompt if needed, dropping the transcript middle, never the deliverable.
  const transcript = turn
    .map((e) => {
      if (e.marker) return e.marker;
      if (e.tool) return e.agent ? `[subagent:${e.agent} tool] ${e.tool}` : `[tool] ${e.tool}`;
      return e.agent ? `[subagent:${e.agent}] ${e.text}` : `[${e.role}] ${e.text}`;
    })
    .join("\n");
  return { request, transcript, output };
}
