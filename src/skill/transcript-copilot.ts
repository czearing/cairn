import { readFileSync } from "node:fs";
import { isSystemEnvelope } from "./noise";
import { hintFrom, latestTurnRange, normalizedTool, str, type RunInput } from "./cycle";

// Extract the latest human turn from a GitHub Copilot CLI transcript as a RunInput. Copilot writes one JSON
// event per line to ~/.copilot/session-state/<id>/events.jsonl. The turn carries:
//   • the human request, with host system-envelope messages (notifications, reminders) never counting as one;
//   • the deliverable: the agent's visible messages plus durable artifact writes and Harness task completion
//     results, so a terse final status cannot hide the work;
//   • the full ordered process with timestamps and subagent activity tagged inline.
// Subagent messages/tools are interleaved in this same log (agentId-tagged), so a subagent's deliverable is
// captured too.

interface Event {
  type: string;
  role: "user" | "assistant" | "other";
  text: string;
  tool?: string;
  toolArgs?: unknown;
  agent?: string;
  marker?: string;
  thinking?: boolean;
  ts: number;
}

const clock = (ts: number): string => (ts > 0 ? new Date(ts).toISOString().slice(11, 19) : "");

function artifactWrite(event: Event): string {
  if (!event.tool) return "";
  const tool = normalizedTool(event.tool);
  if (tool === "apply_patch" && typeof event.toolArgs === "string") {
    return event.toolArgs.trim();
  }
  if (tool.endsWith("task_complete") && event.toolArgs) {
    let args: Record<string, unknown>;
    try {
      args = typeof event.toolArgs === "string"
        ? JSON.parse(event.toolArgs) as Record<string, unknown>
        : event.toolArgs as Record<string, unknown>;
    } catch {
      return "";
    }
    const result = str(args.result) || str(args.output) || str(args.body) || str(args.summary);
    return result ? `Harness task completion result:\n${result}` : "";
  }
  if (!["create", "edit", "write"].includes(tool) || !event.toolArgs || typeof event.toolArgs !== "object") {
    return "";
  }
  const args = event.toolArgs as Record<string, unknown>;
  const path = str(args.path) || str(args.file_path) || str(args.filename);
  const content = str(args.content) || str(args.new_string) || str(args.text);
  return content ? `${path ? `File: ${path}\n` : ""}${content}` : "";
}

function deliverableOutput(events: Event[]): string {
  const messages = visibleMessages(events).join("\n\n").trim();
  const artifacts = events.map(artifactWrite).filter(Boolean);
  const durable = artifacts.length
    ? `DURABLE ARTIFACT WRITES:\n${artifacts.join("\n\n---\n\n")}`
    : "";
  return [messages, durable].filter(Boolean).join("\n\n").trim();
}

const visibleMessages = (events: Event[]): string[] => events
  .filter((event) => event.role === "assistant" && event.text && !event.thinking)
  .map((event) => event.text);

export function extractRunCopilot(path: string): RunInput | null {
  let lines: string[];
  try { lines = readFileSync(path, "utf8").split("\n").filter(Boolean); } catch { return null; }

  const agentName = new Map<string, string>(); // agentId -> a short human name, learned from subagent.started
  const events: Event[] = [];
  for (const line of lines) {
    let o: { type?: string; agentId?: unknown; timestamp?: unknown; data?: { content?: unknown; reasoningText?: unknown; toolName?: unknown; arguments?: unknown; agentName?: unknown; agentDisplayName?: unknown } };
    try { o = JSON.parse(line); } catch { continue; }
    const type = str(o.type);
    const data = o.data ?? {};
    const ts = typeof o.timestamp === "number"
      ? o.timestamp
      : typeof o.timestamp === "string"
        ? Date.parse(o.timestamp) || 0
        : 0;
    const agentId = str(o.agentId);
    const agent = agentId ? (agentName.get(agentId) || "subagent") : undefined;

    if (type === "subagent.started") {
      const name = str(data.agentDisplayName) || str(data.agentName) || "subagent";
      if (agentId) agentName.set(agentId, name);
      events.push({ type, role: "other", text: "", marker: `↳ spawned subagent: ${name}`, ts });
    } else if (type === "subagent.completed") {
      const name = (agentId && agentName.get(agentId)) || str(data.agentDisplayName) || str(data.agentName) || "subagent";
      events.push({ type, role: "other", text: "", marker: `↳ subagent ${name} returned`, ts });
    } else if (type === "user.message") {
      const t = str(data.content);
      if (t) events.push({ type, role: "user", text: t, ts });
    } else if (type === "assistant.message") {
      // The model's THINKING (reasoningText) comes first, then its visible message (content). Capture both,
      // in order, so the receipt check sees how the agent reasoned — not just the final line.
      const reasoning = str(data.reasoningText); if (reasoning) events.push({ type, role: "assistant", text: reasoning, thinking: true, agent, ts });
      const t = str(data.content); if (t) events.push({ type, role: "assistant", text: t, agent, ts });
    } else if (type === "tool.execution_start") {
      const n = str(data.toolName); if (n) events.push({ type, role: "assistant", text: "", tool: n, toolArgs: data.arguments, agent, ts });
    }
  }
  if (events.length === 0) return null;

  const genuineUser = (e: Event) => e.role === "user" && !!e.text && !isSystemEnvelope(e.text);
  const start = latestTurnRange(events, genuineUser);
  if (start < 0) return null;
  // System-envelope user messages are continuations of the same human turn, not boundaries. Exclude the
  // envelope itself, but keep assistant output after it: shell notifications and stop reminders can arrive
  // before the final deliverable, and dropping every following assistant message loses that deliverable.
  const turn = events.slice(start).filter((event) => !(event.role === "user" && isSystemEnvelope(event.text)));
  const request = turn.filter(genuineUser).map((event) => event.text).join("\n").trim();
  // Deliverable = visible messages plus durable artifact/task content. Thinking is process, not the
  // deliverable, so it is excluded here (it still appears in the transcript).
  const output = deliverableOutput(turn);
  if (!request || !output) return null;
  return {
    request, output,
    replies: visibleMessages(turn).map((message) => message.trim()).filter(Boolean),
    transcript: transcriptRows(turn),
  };
}

function transcriptRows(events: Event[]): string {
  const rows = events.map((event) => {
    const time = clock(event.ts) ? `[${clock(event.ts)}] ` : "";
    if (event.marker) return `${time}${event.marker}`;
    if (event.tool) {
      const hint = hintFrom(event.toolArgs);
      const sub = event.agent ? `SUBAGENT:${event.agent} ` : "";
      return `${time}[${sub}TOOL] ${normalizedTool(event.tool)}${hint ? ` "${hint}"` : ""}`;
    }
    const base = event.agent ? `SUBAGENT:${event.agent}` : event.role === "user" ? "USER" : "ASSISTANT";
    return `${time}[${event.thinking ? `${base} THINKING` : base}] ${event.text}`;
  });
  return `TRANSCRIPT (oldest first):\n${rows.join("\n")}`;
}

// Which subagent id most recently produced activity under `agentName`. The Copilot subagent-stop hook needs
// this because the stop event does not always carry the agentId that owned the turn.
export function latestCopilotAgentId(transcriptPath: string, agentName: string): string {
  if (!transcriptPath || !agentName.trim()) return "";
  let lines: string[];
  try { lines = readFileSync(transcriptPath, "utf8").split("\n").filter(Boolean); } catch { return ""; }
  const agentNames = new Map<string, string>();
  const seen: string[] = [];
  for (const line of lines) {
    try {
      const event = JSON.parse(line) as { type?: unknown; agentId?: unknown; data?: { agentName?: unknown } };
      const agentId = str(event.agentId);
      if (!agentId) continue;
      const startedName = str(event.data?.agentName);
      if (event.type === "subagent.started" && startedName) agentNames.set(agentId, startedName);
      seen.push(agentId);
    } catch { /* skip malformed transcript rows */ }
  }
  for (let index = seen.length - 1; index >= 0; index--) {
    if (agentNames.get(seen[index]!) === agentName) return seen[index]!;
  }
  return "";
}
