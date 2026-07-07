import { writeFileSync, existsSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { cairnMcpServerPath } from "./cairn-mcp";
import type { ClaudeOpts, ClaudeResult } from "./types";

// Headless runner for the local GitHub Copilot CLI — the Copilot twin of claude.ts. The judge/learner is the
// machine's OWN Copilot reached through `copilot -p` using the existing login, so there is no API key (same
// free model as the Claude path). Differences from `claude -p`, all handled here so reviewer.ts stays host-
// agnostic:
//   • No stdin prompt: `copilot -p <text>` takes the prompt as an argv value, so it is capped to stay under
//     the Windows command-line limit (the transcript middle is dropped, never the instructions or deliverable).
//   • No --append-system-prompt: the system role is folded into the prompt text.
//   • MCP env is NOT inherited from the parent process; it must live in the server entry's `env`. So the
//     skill_output capture vars (opts.env) are baked into a one-off --additional-mcp-config, and the user's
//     ambient `cairn` server is disabled for the run so the learner can only reach this capture-wired one.
// Every run is best-effort and NEVER throws.

// Resolve how to launch Copilot as an argv prefix. On Windows `copilot` is an npm .cmd/.ps1 shim; spawning
// the .cmd routes through cmd.exe, whose command line is capped at ~8191 chars — so a large learner prompt
// silently truncates the flags that come after it (the MCP config, tool allowlist), breaking the run. The
// shim just does `node …/npm-loader.js %*`, so we spawn that Node loader directly (Bun → CreateProcess, ~32k
// limit). CAIRN_COPILOT_BIN overrides everything (tests / non-standard installs). Falls back to the shim.
export function copilotInvocation(): string[] {
  if (process.env.CAIRN_COPILOT_BIN) return [process.env.CAIRN_COPILOT_BIN];
  const resolved = Bun.which("copilot");
  if (resolved && /\.(cmd|ps1)$/i.test(resolved)) {
    const base = dirname(resolved);
    const loader = join(base, "node_modules", "@github", "copilot", "npm-loader.js");
    if (existsSync(loader)) {
      const nodeExe = join(base, process.platform === "win32" ? "node.exe" : "node");
      return [existsSync(nodeExe) ? nodeExe : "node", loader];
    }
  }
  return [resolved || "copilot"];
}

// The learner's MCP server name. Distinct from the user's ambient "cairn" so the two never collide; the
// ambient one is disabled per-run (--disable-mcp-server) so only this capture-wired server is reachable.
const LEARN_SERVER = "cairnlearn";
// Command-line budget for the prompt arg (Windows CreateProcess caps the whole line at ~32k chars).
const PROMPT_BUDGET = Number(process.env.CAIRN_COPILOT_PROMPT_BUDGET || "28000");

const brainDbPath = (): string => process.env.CAIRN_DB_PATH || join(homedir(), ".cairn", "cairn.db");

// Write a one-off Copilot MCP config exposing cairn's brain tools with the capture env baked in, and return
// its path. Copilot loads it via --additional-mcp-config; the user's ambient cairn is disabled for the run.
export function writeLearnMcpConfig(env: Record<string, string> = {}): string {
  const bun = (Bun.which("bun") ?? "bun").replace(/\\/g, "/");
  const cfg = {
    mcpServers: {
      [LEARN_SERVER]: {
        type: "local",
        command: bun,
        args: [cairnMcpServerPath().replace(/\\/g, "/")],
        tools: ["*"],
        env: { CAIRN_DB_PATH: brainDbPath().replace(/\\/g, "/"), ...env },
      },
    },
  };
  const path = join(tmpdir(), `cairn-copilot-learn-${randomUUID()}.json`);
  writeFileSync(path, JSON.stringify(cfg));
  return path;
}

// Cap a prompt to the command-line budget, dropping the MIDDLE (the bulky transcript) so the leading
// instructions+request and the trailing deliverable+submission rules always survive. Pure/testable.
export function capPrompt(prompt: string, budget = PROMPT_BUDGET): string {
  if (prompt.length <= budget) return prompt;
  const marker = "\n\n...[transcript truncated to fit the Copilot command-line limit]...\n\n";
  const head = Math.floor((budget - marker.length) * 0.6);
  const tail = budget - marker.length - head;
  return prompt.slice(0, head) + marker + prompt.slice(prompt.length - tail);
}

// Pure: assemble the argv AFTER the prompt (the prompt is args[1]). `mcpConfigPath` is set only for a call
// that needs the brain (the learn step); a call that passes none gets no tools at all (a tool-free call).
// Exported for deterministic tests.
export function buildArgs(opts: ClaudeOpts = {}, mcpConfigPath?: string): string[] {
  const args = ["-s", "--no-color", "--no-custom-instructions"]; // silent (response only), reproducible
  if (opts.model) args.push("--model", opts.model);
  if (mcpConfigPath) {
    args.push("--additional-mcp-config", `@${mcpConfigPath.replace(/\\/g, "/")}`); // fwd slashes: Copilot fails to load a backslash path
    args.push("--disable-mcp-server", process.env.CAIRN_MCP_NAME || "cairn"); // drop ambient cairn (no capture env)
    args.push("--disable-builtin-mcps"); // no github-mcp-server; keep the learner focused on the brain
    // Restrict to ONLY the brain tools the learner needs (mapped to this run's server), so with --allow-all-tools
    // auto-approving them it still can never edit files or run shell. Mirrors the Claude path's tight allowlist.
    const tools = (opts.allowedTools?.length ? opts.allowedTools : ["mcp__cairn__brain_search", "mcp__cairn__skill_output"])
      .map((t) => `${LEARN_SERVER}-${t.includes("__") ? t.slice(t.lastIndexOf("__") + 2) : t}`);
    for (const t of tools) args.push("--available-tools", t);
    args.push("--allow-all-tools"); // required to auto-approve tool use in non-interactive mode
  }
  // No mcpConfigPath ⇒ no --allow-all-tools, so any tool attempt is auto-denied: a tool-free reasoning call.
  return args;
}

// Spawn `copilot -p <prompt> …`, collect stdout, bounded by timeoutMs. Resolves { ok, text, error }; never
// rejects. Uses Bun.spawn (not node:child_process) because on Windows `copilot` is a .cmd shim that Bun runs
// correctly with a safe arg array — node's spawn cannot. The cairn server's capture env (opts.env) is written
// into a temp --additional-mcp-config when the call needs the brain. Mirrors runClaude's contract exactly.
export async function runCopilot(prompt: string, opts: ClaudeOpts = {}): Promise<ClaudeResult> {
  const timeoutMs = opts.timeoutMs ?? 90_000;
  // The learn call is signalled by opts.mcpConfigPath (claude uses it for --mcp-config); on Copilot we ignore
  // that path and write our own capture-wired config instead.
  const needsBrain = Boolean(opts.mcpConfigPath);
  const cfgPath = needsBrain ? writeLearnMcpConfig(opts.env ?? {}) : undefined;
  const full = opts.system ? `${opts.system}\n\n${prompt}` : prompt;
  const argv = ["-p", capPrompt(full), ...buildArgs(opts, cfgPath)];
  // Launch via the resolved invocation (Node loader on Windows to dodge the cmd.exe arg-length cap). Do NOT
  // pass a custom env — Bun inherits the parent env by default (which already carries CAIRN_SKILL_WORKER), and
  // overriding it on Windows breaks the PATH-cased command resolution and yields a spurious ENOENT.
  const inv = copilotInvocation();
  const bin = inv[0] ?? "copilot";
  const prefix = inv.slice(1);
  const clip = (s: string) => s.replace(/\s+/g, " ").trim().slice(0, 300);

  let proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
  try {
    // windowsHide: this runs from the detached background worker, which has no console to inherit — without
    // CREATE_NO_WINDOW, spawning node.exe (the copilot loader) pops a visible console window on every review.
    // Hiding it also gives the copilot process an invisible console its own children (the learn MCP server)
    // inherit, so nothing flashes on screen. No-op off Windows. Mirrors claude.ts / embed.ts.
    proc = Bun.spawn([bin, ...prefix, ...argv], { stdin: "ignore", stdout: "pipe", stderr: "pipe", windowsHide: true });
  } catch (e) {
    return { ok: false, text: "", error: `spawn failed: ${e instanceof Error ? e.message : String(e)}` };
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<ClaudeResult>((resolve) => {
    timer = setTimeout(() => { try { proc.kill(); } catch { /* gone */ } resolve({ ok: false, text: "", error: `timed out after ${timeoutMs}ms` }); }, timeoutMs);
  });
  const run = (async (): Promise<ClaudeResult> => {
    try {
      const [out, err, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      return code === 0 ? { ok: true, text: out } : { ok: false, text: out, error: clip(err) || `exited with code ${code}` };
    } catch (e) {
      return { ok: false, text: "", error: e instanceof Error ? e.message : String(e) };
    }
  })();

  const result = await Promise.race([run, timeout]);
  if (timer) clearTimeout(timer);
  return result;
}
