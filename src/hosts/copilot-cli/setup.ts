// Install/uninstall helpers for the GitHub Copilot CLI host. Copilot CLI reads MCP servers from
// ~/.copilot/mcp-config.json and hooks from ~/.copilot/hooks/*.json, so — unlike Claude Code, which
// needs the `claude` CLI — we set Copilot up by merging two JSON files directly. Both writes are
// idempotent. Paths are env-overridable (CAIRN_COPILOT_MCP_PATH / CAIRN_COPILOT_HOOK_PATH) so tests
// and sandboxes never touch the real ~/.copilot.
//
// Two channels, matching what Copilot CLI actually honors (verified on v1.0.62):
//   • mcp-config.json   → exposes brain_search/brain_create/brain_mutate as agent-invoked tools.
//   • hooks/cairn.json  → a sessionStart hook whose additionalContext is injected every session,
//     forcing the "call brain_search first" policy (userPromptSubmitted output is ignored by Copilot).
import { existsSync, mkdirSync } from "node:fs";
import { readFile, writeFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..", "..", ".."); // src/hosts/copilot-cli → repo root
const SERVER = join(ROOT, "src", "mcp", "server.ts");
const HOOK = join(ROOT, "src", "hosts", "copilot-cli", "hook.ts");

const mcpName = () => process.env.CAIRN_MCP_NAME || "cairn";
const bunExe = () => Bun.which("bun") ?? "bun";

export const copilotMcpPath = () =>
  process.env.CAIRN_COPILOT_MCP_PATH || join(homedir(), ".copilot", "mcp-config.json");
export const copilotHookPath = () =>
  process.env.CAIRN_COPILOT_HOOK_PATH || join(homedir(), ".copilot", "hooks", "cairn.json");

// Only touch ~/.copilot when the user actually uses Copilot CLI: it's on PATH, a config dir already
// exists, or a test/sandbox pointed us at explicit paths. CAIRN_SKIP_COPILOT forces a skip.
export function copilotTargeted(): boolean {
  if (process.env.CAIRN_SKIP_COPILOT) return false;
  if (process.env.CAIRN_COPILOT_MCP_PATH || process.env.CAIRN_COPILOT_HOOK_PATH) return true;
  if (Bun.which("copilot")) return true;
  return existsSync(join(homedir(), ".copilot"));
}

type Result = "added" | "already" | "would-add";
interface McpConfig {
  mcpServers?: Record<string, unknown>;
  [k: string]: unknown;
}

// Merge the cairn server into mcp-config.json, preserving any other servers and unknown keys.
export async function installCopilotMcp(dryRun: boolean): Promise<Result> {
  const path = copilotMcpPath();
  const cfg: McpConfig = existsSync(path) ? JSON.parse(await readFile(path, "utf8")) : {};
  const servers = cfg.mcpServers ?? (cfg.mcpServers = {});
  if (servers[mcpName()]) return "already";
  if (dryRun) return "would-add";
  servers[mcpName()] = {
    type: "local", // Copilot CLI's name for a local stdio server
    command: bunExe(),
    args: [SERVER],
    env: {}, // inherit CAIRN_DB_PATH (default ~/.cairn/cairn.db) so a custom brain path is respected
    tools: ["*"], // required by Copilot CLI to enable the server's tools
  };
  mkdirSync(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(cfg, null, 2)}\n`, "utf8");
  return "added";
}

// Two events — the ones Copilot CLI actually injects: sessionStart (the full brain workflow, once
// per session) and postToolUse (per-tool reminders after a brain_* call). hook.ts picks the mode
// from its argv. userPromptSubmitted and a Stop loop are intentionally absent — Copilot ignores the
// former's output and has no stop event.
function hookConfig(): object {
  const win = (p: string) => p.replace(/\//g, "\\");
  const nix = (p: string) => p.replace(/\\/g, "/");
  const bun = bunExe();
  const cmd = (mode: string) => ({
    type: "command",
    powershell: `& '${win(bun)}' '${win(HOOK)}' ${mode}`,
    bash: `'${nix(bun)}' '${nix(HOOK)}' ${mode}`,
  });
  return {
    version: 1,
    hooks: {
      sessionStart: [cmd("session-start")],
      postToolUse: [cmd("post-tool")],
    },
  };
}

// Write the cairn hook file (its own file, so it never collides with the user's other hooks). The
// idempotency marker is "post-tool": an older single-event file lacks it and gets upgraded in place.
export async function installCopilotHook(dryRun: boolean): Promise<Result> {
  const path = copilotHookPath();
  if (existsSync(path) && (await readFile(path, "utf8")).includes("post-tool")) return "already";
  if (dryRun) return "would-add";
  mkdirSync(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(hookConfig(), null, 2)}\n`, "utf8");
  return "added";
}

// Clean reversal: drop the cairn server from mcp-config.json (keeping other servers) and delete the
// hook file. Reports what was actually removed.
export async function removeCopilot(): Promise<{ mcp: boolean; hook: boolean }> {
  let mcp = false;
  let hook = false;

  const mcpP = copilotMcpPath();
  if (existsSync(mcpP)) {
    const cfg: McpConfig = JSON.parse(await readFile(mcpP, "utf8"));
    if (cfg.mcpServers && mcpName() in cfg.mcpServers) {
      delete cfg.mcpServers[mcpName()];
      await writeFile(mcpP, `${JSON.stringify(cfg, null, 2)}\n`, "utf8");
      mcp = true;
    }
  }

  const hookP = copilotHookPath();
  if (existsSync(hookP) && (await readFile(hookP, "utf8")).includes("copilot-cli")) {
    await rm(hookP);
    hook = true;
  }
  return { mcp, hook };
}
