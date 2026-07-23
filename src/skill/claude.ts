import { spawn } from "node:child_process";
import type { ClaudeOpts, ClaudeResult } from "./types";

// Headless runner for the local Claude Code CLI. The judge/compactor is the machine's OWN Claude reached
// through `claude -p` using the existing login, so there is no API key. The flags below make the spawned
// instance clean and cairn-connected: `--setting-sources project` drops the user-level settings (where
// cairn's own workflow/Stop hooks live, which would otherwise pollute the output), while `--mcp-config`
// still hands it the cairn brain server. The prompt is fed on stdin so a long conversation never hits the
// command-line length limit. Every run is best-effort and NEVER throws.

// CAIRN_CLAUDE_BIN overrides for non-standard installs; default resolves the platform launcher on PATH.
export const BIN = process.env.CAIRN_CLAUDE_BIN || (process.platform === "win32" ? "claude.exe" : "claude");

// Pure: assemble the argv (no prompt; the prompt goes on stdin). Exported for deterministic tests.
export function buildArgs(opts: ClaudeOpts = {}): string[] {
  const args = ["-p", "--setting-sources", "project", "--output-format", "text"];
  if (opts.model) args.push("--model", opts.model); // pin a faster model for the background learner
  if (opts.system) args.push("--append-system-prompt", opts.system);
  if (opts.mcpConfigPath) args.push("--mcp-config", opts.mcpConfigPath);
  args.push("--allowedTools", (opts.allowedTools ?? []).join(",")); // empty string = no tools
  return args;
}

// Spawn the CLI, feed `prompt` on stdin, collect stdout, bounded by timeoutMs. Resolves { ok, text, error };
// never rejects. `error` carries the REAL reason a call failed (stderr, exit code, timeout, or spawn error)
// so callers can report it instead of guessing.
export function runClaude(prompt: string, opts: ClaudeOpts = {}): Promise<ClaudeResult> {
  const benchmark = Boolean(opts.env?.CAIRN_PROMPT_BENCHMARK_SESSION);
  const timeoutMs = benchmark ? null : opts.timeoutMs ?? 90_000;
  return new Promise((resolve) => {
    let out = "", err = "", settled = false;
    const done = (r: ClaudeResult) => { if (!settled) { settled = true; resolve(r); } };
    const clip = (s: string) => s.replace(/\s+/g, " ").trim().slice(0, 300);
    const promptArgument = benchmark;
    const args = buildArgs(opts);
    if (promptArgument) args.splice(1, 0, prompt);
    let child: ReturnType<typeof spawn>;
    const bin = process.env.CAIRN_CLAUDE_BIN || BIN; // read at call time so tests can point it at a failing command
    try { child = spawn(bin, args, {
      cwd: opts.cwd,
      stdio: [promptArgument ? "ignore" : "pipe", "pipe", "pipe"],
      windowsHide: true,
      env: opts.env ? { ...process.env, ...opts.env } : undefined,
    }); }
    catch (e) { return done({ ok: false, text: "", error: `spawn failed: ${e instanceof Error ? e.message : String(e)}` }); }
    const timer = timeoutMs == null ? undefined : setTimeout(() => {
      try { child.kill(); } catch { /* gone */ }
      done({ ok: false, text: out, error: `timed out after ${timeoutMs}ms` });
    }, timeoutMs);
    child.stdout?.on("data", (d) => { out += String(d); });
    child.stderr?.on("data", (d) => { err += String(d); });
    child.on("error", (e) => {
      if (timer) clearTimeout(timer);
      done({ ok: false, text: "", error: e.message });
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      done(code === 0
        ? { ok: true, text: out }
        : { ok: false, text: out, error: clip(err) || clip(out) || `exited with code ${code}` });
    });
    if (!promptArgument) {
      try { child.stdin?.end(prompt); } catch { /* stdin closed early; close handler still fires */ }
    }
  });
}
