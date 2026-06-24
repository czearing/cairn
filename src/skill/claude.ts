import { spawn } from "node:child_process";
import type { ClaudeOpts, ClaudeResult } from "./types";

// Headless runner for the local Claude Code CLI. The judge/compactor is the machine's OWN Claude reached
// through `claude -p` using the existing login, so there is no API key. The flags below make the spawned
// instance clean and cairn-connected: `--setting-sources project` drops the user-level settings (where
// cairn's own workflow/Stop hooks live, which would otherwise pollute the output), while `--mcp-config`
// still hands it the cairn brain server. The prompt is fed on stdin so a long conversation never hits the
// command-line length limit. Every run is best-effort and NEVER throws.

const BIN = process.platform === "win32" ? "claude.exe" : "claude";

// Pure: assemble the argv (no prompt; the prompt goes on stdin). Exported for deterministic tests.
export function buildArgs(opts: ClaudeOpts = {}): string[] {
  const args = ["-p", "--setting-sources", "project", "--output-format", "text"];
  if (opts.system) args.push("--append-system-prompt", opts.system);
  if (opts.mcpConfigPath) args.push("--mcp-config", opts.mcpConfigPath);
  args.push("--allowedTools", (opts.allowedTools ?? []).join(",")); // empty string = no tools
  return args;
}

// Spawn the CLI, feed `prompt` on stdin, collect stdout, bounded by timeoutMs. Resolves { ok, text };
// never rejects.
export function runClaude(prompt: string, opts: ClaudeOpts = {}): Promise<ClaudeResult> {
  const timeoutMs = opts.timeoutMs ?? 90_000;
  return new Promise((resolve) => {
    let out = "", settled = false;
    const done = (r: ClaudeResult) => { if (!settled) { settled = true; resolve(r); } };
    let child: ReturnType<typeof spawn>;
    try { child = spawn(BIN, buildArgs(opts), { stdio: ["pipe", "pipe", "ignore"] }); }
    catch { return done({ ok: false, text: "" }); }
    const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } done({ ok: false, text: out }); }, timeoutMs);
    child.stdout?.on("data", (d) => { out += String(d); });
    child.on("error", () => { clearTimeout(timer); done({ ok: false, text: "" }); });
    child.on("close", (code) => { clearTimeout(timer); done({ ok: code === 0, text: out }); });
    try { child.stdin?.end(prompt); } catch { /* stdin closed early; close handler still fires */ }
  });
}
