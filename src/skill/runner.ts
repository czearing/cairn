import { runClaude } from "./claude";
import { runCopilot } from "./copilot";
import type { ClaudeOpts, ClaudeResult } from "./types";

// Host-agnostic learner entry point. The skill pipeline (reviewer.ts) calls runLearner; this picks the
// backing CLI so the SAME grade/classify/learn flow runs free on either host's own login — `claude -p` or
// `copilot -p`. The choice is explicit via CAIRN_LEARN_BACKEND (the triggering hook sets it), else auto:
// prefer the CLI that is actually installed, defaulting to claude to preserve existing behavior.

export type Backend = "claude" | "copilot";

// Resolve the backend. Read at call time so a test or a per-host hook can set it. "auto" (or unset) probes
// PATH: claude first (the original host), then copilot.
export function learnerBackend(): Backend {
  const v = (process.env.CAIRN_LEARN_BACKEND || "").trim().toLowerCase();
  if (v === "claude" || v === "copilot") return v;
  if (Bun.which("claude")) return "claude";
  if (Bun.which("copilot")) return "copilot";
  return "claude"; // nothing found: keep the historical default so errors read as a missing claude
}

// Dispatch one headless learner call to the selected CLI. Identical contract to runClaude/runCopilot.
export function runLearner(prompt: string, opts: ClaudeOpts = {}): Promise<ClaudeResult> {
  return learnerBackend() === "copilot" ? runCopilot(prompt, opts) : runClaude(prompt, opts);
}
