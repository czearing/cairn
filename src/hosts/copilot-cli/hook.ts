#!/usr/bin/env bun
// GitHub Copilot CLI hooks for Cairn — two modes, selected by argv[2]:
//   session-start : inject the full brain workflow (prompts/user-message.md) ONCE per session.
//   post-tool     : after a brain tool runs, inject the matching reminder prompt (search-results /
//                   node-created / node-modified / answer-check), mirroring Claude Code's PostToolUse.
//
// Both emit {"additionalContext": "..."}, the channel Copilot CLI actually injects (sessionStart
// since v1.0.12, postToolUse since v1.0.5). It does NOT use userPromptSubmitted (its output is
// ignored), and Copilot has no Stop event — so the per-PROMPT cadence and the split-enforcement loop
// of Claude Code cannot be matched; this is the closest reachable parity.
import { readFile } from "node:fs/promises";

const PROMPTS = new URL("../../../prompts/", import.meta.url);
const emit = (obj: object) => process.stdout.write(JSON.stringify(obj));
const promptText = async (file: string): Promise<string> => {
  try {
    return (await readFile(new URL(file, PROMPTS), "utf8")).trim();
  } catch {
    return "";
  }
};
// MCP tools may arrive bare ("brain_search") or namespaced ("mcp__cairn__brain_search" / "cairn-…").
const isTool = (name: string, want: string) => name === want || name.endsWith(want) || name.includes(want);

const mode = process.argv[2];

if (mode === "session-start") {
  const text = await promptText("user-message.md");
  emit(text ? { additionalContext: text } : {});
} else if (mode === "post-tool") {
  const raw = await Bun.stdin.text();
  if (process.env.CAIRN_HOOK_DEBUG) {
    try {
      const { appendFileSync } = await import("node:fs");
      const { join } = await import("node:path");
      const { tmpdir } = await import("node:os");
      appendFileSync(join(tmpdir(), "cairn-copilot-hook.log"), `[post-tool] ${raw.slice(0, 300)}\n`);
    } catch {}
  }
  let toolName = "";
  let answer = "";
  try {
    const j = JSON.parse(raw) as { toolName?: string; toolArgs?: unknown };
    toolName = j.toolName ?? "";
    // toolArgs arrives as a JSON-encoded string (Copilot CLI), occasionally already an object.
    const args = (typeof j.toolArgs === "string" ? JSON.parse(j.toolArgs) : j.toolArgs) as
      | { answer?: unknown }
      | undefined;
    answer = typeof args?.answer === "string" ? args.answer : "";
  } catch {}
  let file = "";
  if (isTool(toolName, "brain_search")) file = "search-results.md";
  else if (isTool(toolName, "brain_create")) file = "node-created.md";
  else if (isTool(toolName, "brain_mutate")) file = answer.trim() ? "answer-check.md" : "node-modified.md";
  const text = file ? await promptText(file) : "";
  emit(text ? { additionalContext: text } : {});
} else {
  emit({});
}
