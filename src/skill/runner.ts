import { runClaude } from "./claude";
import { runCopilot } from "./copilot";
import type { ClaudeOpts, ClaudeResult } from "./types";

// Host-agnostic learner entry point. The skill pipeline (reviewer.ts) calls runLearner; this picks the
// backing CLI so the SAME grade/learn flow runs free on the machine's own login — `copilot -p` or `claude -p`.
// The choice is explicit via CAIRN_LEARN_BACKEND (the triggering hook sets it), else auto: prefer copilot (the
// GitHub Copilot CLI login, the common no-API-key path), then claude.

export type Backend = "claude" | "copilot";

// Resolve the backend. Read at call time so a test or a per-host hook can set it. Unset/auto probes PATH:
// copilot first (the default learner), then claude; defaults to copilot.
export function learnerBackend(): Backend {
  const v = (process.env.CAIRN_LEARN_BACKEND || "").trim().toLowerCase();
  if (v === "claude" || v === "copilot") return v;
  if (Bun.which("copilot")) return "copilot";
  if (Bun.which("claude")) return "claude";
  return "copilot"; // default to the Copilot CLI login (no API key needed)
}

// Dispatch one headless learner call to the selected CLI. Identical contract to runClaude/runCopilot.
export function runLearner(prompt: string, opts: ClaudeOpts = {}): Promise<ClaudeResult> {
  return learnerBackend() === "copilot" ? runCopilot(prompt, opts) : runClaude(prompt, opts);
}
