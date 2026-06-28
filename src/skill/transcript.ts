import { readFileSync } from "node:fs";
import type { RunInput } from "./pipeline";

// Extract a RunInput for the CURRENT turn from a Claude Code transcript (JSONL, one message object per line).
// A session can hold many unrelated tasks (a poem, then a haiku); reviewing the whole session mis-attributes
// the run to the first message and wastes tokens. So we scope to the latest turn only: the most recent user
// prompt(s) and the assistant response that followed them. Successive user messages sent before any assistant
// reply are batched into that one turn. Best-effort: returns null if the file is unreadable or has no usable turn.

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((c) => (typeof c === "string" ? c : (c as { type?: string; text?: string })?.type === "text" ? (c as { text?: string }).text ?? "" : "")).join(" ").trim();
  return "";
}

// A user-role message carrying a tool_result is Claude Code's representation of a tool's OUTPUT, not a human
// prompt. It must not count as a user turn, or it would split the current turn at every tool call.
function isToolResult(content: unknown): boolean {
  return Array.isArray(content) && content.some((c) => (c as { type?: string })?.type === "tool_result");
}

export function extractRun(path: string): RunInput | null {
  let lines: string[];
  try { lines = readFileSync(path, "utf8").split("\n").filter(Boolean); } catch { return null; }
  const turns: { role: "user" | "assistant"; text: string }[] = [];
  for (const line of lines) {
    let o: { type?: string; message?: { content?: unknown } };
    try { o = JSON.parse(line); } catch { continue; }
    const role = o.type === "user" ? "user" : o.type === "assistant" ? "assistant" : null;
    if (!role) continue;
    if (role === "user" && isToolResult(o.message?.content)) continue; // tool output, not a human prompt
    const text = textOf(o.message?.content);
    if (text) turns.push({ role, text });
  }
  if (turns.length === 0) return null;

  // Scope to the current turn: everything after the LAST assistant->user boundary. An earlier task in the
  // same session (the poem before the haiku) is excluded, so the run is attributed and graded on the latest
  // ask only. With no boundary (a single turn) this keeps the whole thing.
  let start = 0;
  for (let i = 0; i < turns.length - 1; i++) { const a = turns[i], b = turns[i + 1]; if (a && b && a.role === "assistant" && b.role === "user") start = i + 1; }
  const turn = turns.slice(start);

  // Request = the user prompt(s) that opened this turn (successive messages batched). Output = the last
  // assistant message of the turn. Transcript = just this turn, capped.
  // Request = the user prompt(s) that opened this turn; output = the last assistant message; transcript = this
  // turn, capped. No content filtering here: classifying what a turn is (a real task, a system-event reply, a
  // non-task) is the LEARNER's job, which reads the deliverable and assigns the label or an empty one. A bare
  // string filter here would be a guess that the intelligent layer already makes better.
  const request = turn.filter((t) => t.role === "user").map((t) => t.text).join("\n").trim();
  const output = [...turn].reverse().find((t) => t.role === "assistant")?.text ?? "";
  if (!request || !output) return null;
  const transcript = turn.map((t) => `[${t.role}] ${t.text}`).join("\n").slice(0, 8000);
  return { request, transcript, output };
}
