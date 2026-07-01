import { readFileSync } from "node:fs";
import type { RunInput } from "./pipeline";
import { isSystemEnvelope } from "./noise";

// Extract a RunInput for the current REVIEW CYCLE from a GitHub Copilot CLI transcript. Copilot writes one JSON
// event per line to ~/.copilot/session-state/<id>/events.jsonl. A review cycle is everything the agent did to
// produce the deliverable it is now submitting: we scope the DETAILED process to everything since the PREVIOUS
// skill_review call (or the session start, for the first review), NOT just the last user turn — so multi-turn
// refinement, guidance, and corrections are all graded. On top of that we give the reviewer, for context:
//   • every USER message in the whole session (condensed to timestamp + text), incl. earlier cycles;
//   • the list of skills the agent loaded/created this cycle (skill_search / skill_create / skill_review);
//   • the full ordered process of THIS cycle with timestamps, subagent activity tagged inline.
// Subagent messages/tools are interleaved in this same log (agentId-tagged), so a subagent's deliverable is
// captured too. Host system-envelope user messages (notifications, reminders) never count as a human prompt.

interface Event { type: string; role: "user" | "assistant" | "other"; text: string; tool?: string; toolArgs?: string; agent?: string; marker?: string; thinking?: boolean; ts: number }

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const clock = (ts: number): string => (ts > 0 ? new Date(ts).toISOString().slice(11, 19) : "");
const isReviewTool = (name: string): boolean => name.endsWith("skill_review") || name.includes("skill_review");
// A tool's args arrive as a JSON string or object; pull a short human hint (the query/label) for the loaded list.
function argHint(raw: unknown): string {
  let o: { task?: unknown; label?: unknown; query?: unknown; what?: unknown } = {};
  try { o = typeof raw === "string" ? JSON.parse(raw) : (raw ?? {}) as typeof o; } catch { return ""; }
  return str(o.label) || str(o.task) || str(o.query) || str(o.what);
}

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
    const ts = typeof o.timestamp === "number" ? o.timestamp : 0;
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
      const t = str(data.content); if (t) events.push({ type, role: "user", text: t, ts });
    } else if (type === "assistant.message") {
      // The model's THINKING (reasoningText) comes first, then its visible message (content). Capture both,
      // in order, so the reviewer sees how the agent reasoned — not just the final line.
      const reasoning = str(data.reasoningText); if (reasoning) events.push({ type, role: "assistant", text: reasoning, thinking: true, agent, ts });
      const t = str(data.content); if (t) events.push({ type, role: "assistant", text: t, agent, ts });
    } else if (type === "tool.execution_start") {
      const n = str(data.toolName); if (n) events.push({ type, role: "assistant", text: "", tool: n, toolArgs: str(data.arguments), agent, ts });
    }
  }
  if (events.length === 0) return null;

  // The DETAIL window is the current review cycle: everything since the PREVIOUS skill_review call. The LAST
  // skill_review in the log is the one that triggered this review, so we cut after the one BEFORE it; with only
  // one (the first review ever) we take the whole session.
  const reviewIdxs = events.map((e, i) => (e.tool && isReviewTool(e.tool) ? i : -1)).filter((i) => i >= 0);
  const detailStart = reviewIdxs.length >= 2 ? reviewIdxs[reviewIdxs.length - 2]! + 1 : 0;
  const cycle = events.slice(detailStart);

  const genuineUser = (e: Event) => e.role === "user" && e.text && !isSystemEnvelope(e.text);
  const request = cycle.filter(genuineUser).map((e) => e.text).join("\n").trim();
  // Deliverable = the agent's VISIBLE messages this cycle (main + subagent). Thinking is process, not the
  // deliverable, so it is excluded here (it still appears in the transcript below).
  const output = cycle.filter((e) => e.role === "assistant" && e.text && !e.thinking).map((e) => e.text).join("\n\n").trim();
  if (!request || !output) return null;

  // ONE chronological transcript of the review cycle: user messages, the agent's thinking, its messages, and
  // its tool calls (skill label/query inline). One section, not dissected — simpler and clearer for the reviewer.
  const toolName = (t: string) => (t.includes("__") ? t.slice(t.lastIndexOf("__") + 2) : t.replace(/^cairn-/, ""));
  const rows = cycle.map((e) => {
    const time = clock(e.ts) ? `[${clock(e.ts)}] ` : "";
    if (e.marker) return `${time}${e.marker}`;
    if (e.tool) { const hint = argHint(e.toolArgs); const sub = e.agent ? `SUBAGENT:${e.agent} ` : ""; return `${time}[${sub}TOOL] ${toolName(e.tool)}${hint ? ` "${hint}"` : ""}`; }
    const base = e.agent ? `SUBAGENT:${e.agent}` : e.role === "user" ? "USER" : "ASSISTANT";
    const tag = e.thinking ? `${base} THINKING` : base;
    return `${time}[${tag}] ${e.text}`;
  });
  const transcript = `TRANSCRIPT (oldest first):\n${rows.join("\n")}`;

  return { request, transcript, output };
}
