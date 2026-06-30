import { readFileSync } from "node:fs";
import type { RunInput } from "./pipeline";
import { isSystemEnvelope } from "./noise";

// Extract a RunInput for the CURRENT turn from a Claude Code transcript (JSONL, one message object per line).
// A session can hold many unrelated tasks (a poem, then a haiku); reviewing the whole session mis-attributes
// the run and wastes tokens, so we scope to the latest turn only (everything after the last assistant->user
// boundary). Within that turn we keep EVERYTHING the learner needs to grade fairly: every assistant text
// message (so a deliverable produced mid-turn is never lost behind end-of-turn bookkeeping), the tool calls
// (so the learner sees it searched skills, spawned a subagent, etc.), and the message timestamps.

interface Parts { text: string; tools: string[] }
// Split one message's content into its visible text and the NAMES of the tools it invoked, so the learner
// can see the ACTION sequence without the noisy full tool inputs/outputs.
function partsOf(content: unknown): Parts {
  if (typeof content === "string") return { text: content.trim(), tools: [] };
  if (!Array.isArray(content)) return { text: "", tools: [] };
  const texts: string[] = [], tools: string[] = [];
  for (const c of content) {
    const o = c as { type?: string; text?: string; name?: string };
    if (o?.type === "text" && typeof o.text === "string") texts.push(o.text);
    else if (o?.type === "tool_use" && typeof o.name === "string") tools.push(o.name.includes("__") ? o.name.slice(o.name.lastIndexOf("__") + 2) : o.name);
  }
  return { text: texts.join(" ").trim(), tools };
}

// A user-role message carrying a tool_result is Claude Code's representation of a tool's OUTPUT, not a human
// prompt. It must not count as a user turn, or it would split the current turn at every tool call.
function isToolResult(content: unknown): boolean {
  return Array.isArray(content) && content.some((c) => (c as { type?: string })?.type === "tool_result");
}

// HH:MM:SS from an ISO timestamp ("2026-06-24T19:45:35.130Z"), or "" when the line has no timestamp.
function clock(ts: unknown): string { return typeof ts === "string" && ts.length >= 19 && ts[10] === "T" ? ts.slice(11, 19) : ""; }

interface Event { role: "user" | "assistant"; text: string; tools: string[]; ts: string }

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
    if (!p.text && !p.tools.length) continue;                          // skip empty/system frames
    events.push({ role, text: p.text, tools: p.tools, ts: clock(o.timestamp) });
  }
  if (events.length === 0) return null;

  // Scope to the current turn: everything after the LAST assistant->user boundary. An earlier task in the same
  // session (the poem before the haiku) is excluded. A tool-only assistant frame is role=assistant, so it never
  // creates a false boundary; only a real user prompt does. A host system-envelope user message (a
  // <task-notification>, a <system_reminder>, a skill-context/slash-command frame) is the harness talking, not
  // the user, so it likewise never opens a turn — the loop must not grade a notification as the task. With no
  // boundary this keeps the whole thing.
  let start = 0;
  for (let i = 0; i < events.length - 1; i++) if (events[i]!.role === "assistant" && events[i + 1]!.role === "user" && !isSystemEnvelope(events[i + 1]!.text)) start = i + 1;
  const turn = events.slice(start);

  // Request = the user prompt(s) that opened this turn (successive messages batched), EXCLUDING any host
  // system-envelope frames so a notification can never become the task. Deliverable = ALL of the agent's text
  // this turn joined, so a story written before end-of-turn bookkeeping is graded, not the last line. The
  // learner (the intelligent layer) picks out the actual deliverable; we never drop it in code.
  const request = turn.filter((e) => e.role === "user" && e.text && !isSystemEnvelope(e.text)).map((e) => e.text).join("\n").trim();
  const output = turn.filter((e) => e.role === "assistant" && e.text).map((e) => e.text).join("\n\n").trim();
  if (!request || !output) return null;
  // Process = the whole turn with timestamps and tool calls, in order, so the learner sees what actually
  // happened (which skills it searched, when it spawned a subagent, where it went back and forth). No length
  // cap: the deliverable must never be truncated out of what gets graded.
  const transcript = turn.map((e) => {
    const time = e.ts ? `${e.ts} ` : "";
    const tools = e.tools.length ? ` (tools: ${e.tools.join("; ")})` : "";
    return `${time}[${e.role}] ${e.text}${tools}`.trimEnd();
  }).join("\n");
  return { request, transcript, output };
}
