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

// The label the agent DECLARED for this turn by calling the skill_use tool, read straight from the tool_use
// entry's input. This is the agent's own pick (made with full context), so the learner can skip its classify
// call and grade/rewrite that skill directly. Returns "" when the message has no skill_use call.
function declaredLabelOf(content: unknown): string {
  if (!Array.isArray(content)) return "";
  for (const c of content) {
    const t = c as { type?: string; name?: string; input?: { label?: unknown } };
    if (t?.type === "tool_use" && typeof t.name === "string" && (t.name === "skill_use" || t.name.endsWith("__skill_use"))) {
      const lbl = t.input?.label;
      if (typeof lbl === "string" && lbl.trim()) return lbl.trim();
    }
  }
  return "";
}

export function extractRun(path: string): RunInput | null {
  let lines: string[];
  try { lines = readFileSync(path, "utf8").split("\n").filter(Boolean); } catch { return null; }
  const turns: { role: "user" | "assistant"; text: string; declared: string }[] = [];
  for (const line of lines) {
    let o: { type?: string; message?: { content?: unknown } };
    try { o = JSON.parse(line); } catch { continue; }
    const role = o.type === "user" ? "user" : o.type === "assistant" ? "assistant" : null;
    if (!role) continue;
    if (role === "user" && isToolResult(o.message?.content)) continue; // tool output, not a human prompt
    const text = textOf(o.message?.content);
    const declared = role === "assistant" ? declaredLabelOf(o.message?.content) : ""; // skill_use marker
    if (text || declared) turns.push({ role, text, declared });
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
  const output = [...turn].reverse().find((t) => t.role === "assistant" && t.text)?.text ?? "";
  if (!request || !output) return null;
  const transcript = turn.filter((t) => t.text).map((t) => `[${t.role}] ${t.text}`).join("\n").slice(0, 8000);
  // The agent's own skill pick this turn (the LAST skill_use it called), so the learner can skip classify.
  const declaredLabel = [...turn].reverse().find((t) => t.declared)?.declared ?? "";
  return { request, transcript, output, declaredLabel };
}
