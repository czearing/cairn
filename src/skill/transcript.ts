import { readFileSync } from "node:fs";
import type { RunInput } from "./pipeline";
import { isSystemEnvelope } from "./noise";

// Extract a RunInput for the current REVIEW CYCLE from a Claude Code transcript (JSONL, one message object per
// line). A review cycle is everything the agent did to produce the deliverable it is now submitting via
// skill_review, so we scope the DETAILED process to everything since the PREVIOUS skill_review call (or the
// session start, for the first review) — NOT just the last turn — so multi-turn refinement and corrections are
// all graded. On top of that we give the reviewer, for context: every USER message in the whole session
// (condensed to timestamp + text, incl. earlier cycles); the skills loaded/created this cycle; and the full
// ordered process of THIS cycle with timestamps and tool calls.

interface Tool { name: string; hint: string }
interface Parts { text: string; thinking: string; tools: Tool[] }
// Pull the reusable label/query hint from a skill tool's input, so the "skills loaded" list can name what was
// searched/created/reviewed. Empty for non-skill tools.
function toolHint(name: string, input: unknown): string {
  if (!/skill_(search|create|review)/.test(name) || !input || typeof input !== "object") return "";
  const o = input as { label?: unknown; task?: unknown; query?: unknown; what?: unknown };
  const s = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  return s(o.label) || s(o.task) || s(o.query) || s(o.what);
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
      const name = o.name.includes("__") ? o.name.slice(o.name.lastIndexOf("__") + 2) : o.name;
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

const isReviewTool = (name: string): boolean => name === "skill_review" || name.endsWith("skill_review");

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

  // The DETAIL window is the current review cycle: everything since the PREVIOUS skill_review call. The LAST
  // skill_review in the log triggered this review, so we cut after the one BEFORE it; with only one (the first
  // review ever) we take the whole session.
  const reviewIdxs = events.map((e, i) => (e.tools.some((t) => isReviewTool(t.name)) ? i : -1)).filter((i) => i >= 0);
  const detailStart = reviewIdxs.length >= 2 ? reviewIdxs[reviewIdxs.length - 2]! + 1 : 0;
  const cycle = events.slice(detailStart);

  const genuineUser = (e: Event) => e.role === "user" && e.text && !isSystemEnvelope(e.text);
  const request = cycle.filter(genuineUser).map((e) => e.text).join("\n").trim();
  // Deliverable = the agent's visible messages (thinking is process, shown in the transcript, not the deliverable).
  const output = cycle.filter((e) => e.role === "assistant" && e.text).map((e) => e.text).join("\n\n").trim();
  if (!request || !output) return null;

  // ONE chronological transcript of the review cycle: user messages, the agent's thinking, its messages, and
  // its tool calls (skill label/query inline). One section, not dissected — simpler and clearer for the reviewer.
  const rows: string[] = [];
  for (const e of cycle) {
    const time = e.ts ? `[${e.ts}] ` : "";
    const role = e.role === "user" ? "USER" : "ASSISTANT";
    if (e.thinking) rows.push(`${time}[${role} THINKING] ${e.thinking}`);
    if (e.text) rows.push(`${time}[${role}] ${e.text}`);
    for (const t of e.tools) rows.push(`${time}[TOOL] ${t.name}${t.hint ? ` "${t.hint}"` : ""}`);
  }
  const transcript = `TRANSCRIPT (oldest first):\n${rows.join("\n")}`;

  return { request, transcript, output };
}
