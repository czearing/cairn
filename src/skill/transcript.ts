import { readFileSync } from "node:fs";
import type { RunInput } from "./pipeline";

// Extract a RunInput from a Claude Code transcript (JSONL, one message object per line): the first user
// message is the request, the last assistant message is the output, and a compact user/assistant rendering
// is the transcript to compact. Best-effort: returns null if the file is unreadable or has no usable turns.

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((c) => (typeof c === "string" ? c : (c as { type?: string; text?: string })?.type === "text" ? (c as { text?: string }).text ?? "" : "")).join(" ").trim();
  return "";
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
    const text = textOf(o.message?.content);
    if (text) turns.push({ role, text });
  }
  const request = turns.find((t) => t.role === "user")?.text ?? "";
  const output = [...turns].reverse().find((t) => t.role === "assistant")?.text ?? "";
  if (!request || !output) return null;
  const transcript = turns.map((t) => `[${t.role}] ${t.text}`).join("\n").slice(0, 8000);
  return { request, transcript, output };
}
