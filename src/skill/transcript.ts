import { readFileSync } from "node:fs";
import { isSystemEnvelope } from "./noise";
import { hintFrom, latestTurnRange, normalizedTool, type RunInput } from "./cycle";

// Extract the latest human turn from a Claude Code transcript (JSONL, one message object per line) as a
// RunInput: the human request, the agent's visible deliverable, and one chronological transcript of the turn
// (user messages, the agent's thinking, its messages, and its tool calls with any skill label inline).

interface Tool { name: string; hint: string }
interface Parts { text: string; thinking: string; tools: Tool[] }
// Pull the reusable label/query hint from a skill tool's input, so tool rows can name what was selected or
// created. Empty for non-skill tools.
function toolHint(name: string, input: unknown): string {
  if (!name.includes("skill_") || !input || typeof input !== "object") return "";
  return hintFrom(input);
}

// Split one message's content into the model's THINKING, its visible text, and the tools it invoked (name +
// skill hint), so the learner sees how the agent reasoned and acted, not just the final line.
function partsOf(content: unknown): Parts {
  if (typeof content === "string") return { text: content.trim(), thinking: "", tools: [] };
  if (!Array.isArray(content)) return { text: "", thinking: "", tools: [] };
  const texts: string[] = [], thinks: string[] = [], tools: Tool[] = [];
  for (const c of content) {
    const o = c as { type?: string; text?: string; thinking?: string; name?: string; input?: unknown };
    if (o?.type === "text" && typeof o.text === "string") texts.push(o.text);
    else if (o?.type === "thinking" && typeof o.thinking === "string") thinks.push(o.thinking);
    else if (o?.type === "tool_use" && typeof o.name === "string") {
      const name = normalizedTool(o.name);
      tools.push({ name, hint: toolHint(name, o.input) });
    }
  }
  return { text: texts.join(" ").trim(), thinking: thinks.join(" ").trim(), tools };
}

// A user-role message carrying a tool_result is Claude Code's representation of a tool's OUTPUT, not a human
// prompt. It must not count as a user turn.
function isToolResult(content: unknown): boolean {
  return Array.isArray(content) && content.some((c) => (c as { type?: string })?.type === "tool_result");
}

// HH:MM:SS from an ISO timestamp ("2026-06-24T19:45:35.130Z"), or "" when the line has no timestamp.
function clock(ts: unknown): string { return typeof ts === "string" && ts.length >= 19 && ts[10] === "T" ? ts.slice(11, 19) : ""; }

interface Event { role: "user" | "assistant"; text: string; thinking: string; tools: Tool[]; ts: string }

export function extractRun(path: string): RunInput | null {
  let lines: string[];
  try { lines = readFileSync(path, "utf8").split("\n").filter(Boolean); } catch { return null; }
  const events: Event[] = [];
  for (const line of lines) {
    let o: { type?: string; message?: { content?: unknown }; timestamp?: unknown };
    try { o = JSON.parse(line); } catch { continue; }
    const role = o.type === "user" ? "user" : o.type === "assistant" ? "assistant" : null;
    if (!role) continue;
    if (role === "user" && isToolResult(o.message?.content)) continue; // tool output, not a human prompt
    const p = partsOf(o.message?.content);
    if (!p.text && !p.thinking && !p.tools.length) continue;          // skip empty/system frames
    events.push({ role, text: p.text, thinking: p.thinking, tools: p.tools, ts: clock(o.timestamp) });
  }
  if (events.length === 0) return null;

  const genuineUser = (e: Event) => e.role === "user" && !!e.text && !isSystemEnvelope(e.text);
  const start = latestTurnRange(events, genuineUser);
  if (start < 0) return null;
  // System-envelope user messages are continuations of the same human turn, not boundaries: drop the envelope
  // itself but keep the assistant output that follows it, which can carry the actual deliverable.
  const turn = events.slice(start).filter((event) => !(event.role === "user" && isSystemEnvelope(event.text)));
  const request = turn.filter(genuineUser).map((event) => event.text).join("\n").trim();
  // Deliverable = the agent's visible messages (thinking is process, shown in the transcript, not the deliverable).
  const visible = turn.filter((event) => event.role === "assistant" && event.text).map((event) => event.text);
  const output = visible.join("\n\n").trim();
  if (!request || !output) return null;
  return {
    request, output,
    replies: visible.map((message) => message.trim()).filter(Boolean),
    transcript: renderTranscript(turn),
  };
}

function renderTranscript(events: Event[]): string {
  const rows: string[] = [];
  for (const event of events) {
    const time = event.ts ? `[${event.ts}] ` : "";
    const role = event.role === "user" ? "USER" : "ASSISTANT";
    if (event.thinking) rows.push(`${time}[${role} THINKING] ${event.thinking}`);
    if (event.text) rows.push(`${time}[${role}] ${event.text}`);
    for (const tool of event.tools) rows.push(`${time}[TOOL] ${tool.name}${tool.hint ? ` "${tool.hint}"` : ""}`);
  }
  return `TRANSCRIPT (oldest first):\n${rows.join("\n")}`;
}
