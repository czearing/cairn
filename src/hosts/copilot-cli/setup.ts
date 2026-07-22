// Install/uninstall helpers for the GitHub Copilot CLI host. Copilot CLI reads MCP servers from
// ~/.copilot/mcp-config.json and hooks from ~/.copilot/hooks/*.json, so — unlike Claude Code, which
// needs the `claude` CLI — we set Copilot up by merging two JSON files directly. Both writes are
// idempotent. Paths are env-overridable (CAIRN_COPILOT_MCP_PATH / CAIRN_COPILOT_HOOK_PATH) so tests
// and sandboxes never touch the real ~/.copilot.
//
// Two channels, matching what Copilot CLI actually honors:
//   • mcp-config.json   → exposes brain_search/brain_create/brain_mutate as agent-invoked tools.
//   • hooks/cairn.json  → userPromptSubmitted injects the workflow once after Copilot has collected
//     the messages for the next model turn.
import { existsSync, mkdirSync } from "node:fs";
import { readFile, writeFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { libsqlEnv } from "../../libsql-env";

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

// Merge the cairn server into mcp-config.json, preserving any other servers and unknown keys. Any
// CAIRN_LIBSQL_* vars in the environment are written into the server's `env` so cloud sync is set up
// by `cairn install` alone. If the server already exists but is missing those vars (sync added after
// the fact), they are folded into its env in place.
export async function installCopilotMcp(dryRun: boolean): Promise<Result> {
  const path = copilotMcpPath();
  const cfg: McpConfig = existsSync(path) ? JSON.parse(await readFile(path, "utf8")) : {};
  const servers = cfg.mcpServers ?? (cfg.mcpServers = {});
  const env = libsqlEnv();
  // Copilot launches the stdio server without a Cairn cwd. Bun --hot then repeatedly warns that imported
  // files are outside its project and can enter a reload-warning loop. Tool schemas are session-scoped
  // anyway, so use one stable process and let /restart pick up source or schema changes.
  const wantArgs = [SERVER];
  const existing = servers[mcpName()] as { command?: string; args?: string[]; env?: Record<string, string> } | undefined;
  if (existing) {
    const cur = existing.env ?? (existing.env = {});
    const envMissing = Object.entries(env).filter(([k, v]) => cur[k] !== v);
    const argsStale = JSON.stringify(existing.args) !== JSON.stringify(wantArgs);
    const cmdStale = existing.command !== bunExe();
    if (!envMissing.length && !argsStale && !cmdStale) return "already";
    if (dryRun) return "would-add";
    for (const [k, v] of envMissing) cur[k] = v;
    if (argsStale) existing.args = wantArgs;
    if (cmdStale) existing.command = bunExe();
    await writeFile(path, `${JSON.stringify(cfg, null, 2)}\n`, "utf8");
    return "added";
  }
  if (dryRun) return "would-add";
  servers[mcpName()] = {
    type: "local", // Copilot CLI's name for a local stdio server
    command: bunExe(),
    args: wantArgs,
    env, // CAIRN_LIBSQL_* if set (cloud sync), else {} — CAIRN_DB_PATH is still inherited from the env
    tools: ["*"], // required by Copilot CLI to enable the server's tools
  };
  mkdirSync(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(cfg, null, 2)}\n`, "utf8");
  return "added";
}

// Events Cairn needs for its brain workflow:
//   userPromptSubmitted → the full workflow at TURN START, on every prompt (Claude UserPromptSubmit parity).
//                         NOTE: the published hooks reference says this event's output is "not processed",
//                         but a live marker test on v1.0.66 proved additionalContext here DOES reach the
//                         model. Do not also inject at sessionStart: both events fire on the first turn.
//   sessionStart        → workflow fallback only on Copilot versions older than v1.0.66, where
//                         userPromptSubmitted output is not delivered to the model.
//   preToolUse          → gate brain_create and prepend the Cairn protocol to general-purpose Task prompts.
//   postToolUse         → entry-format/orchestrate + per-tool reminders after a brain_* or Task call; records
//                         skill selection for delegation.
//   agentStop           → the Stop equivalent: decision:"block" re-runs the turn (turn-reminder when brain
//                         unused) and clears completed turn state after the final visible response.
//   subagentStart       → additionalContext prepended to a spawned subagent's own prompt.
// hook.ts picks the mode from its argv.
function supportsPerPromptContext(): boolean {
  const override = process.env.CAIRN_COPILOT_VERSION;
  const executable = Bun.which("copilot");
  const output = override ?? (executable
    ? `${Bun.spawnSync([executable, "--version"], { stdout: "pipe", stderr: "pipe" }).stdout?.toString() ?? ""}`
    : "");
  const match = output.match(/\b(\d+)\.(\d+)\.(\d+)\b/);
  if (!match) return true;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  return major > 1 || (major === 1 && (minor > 0 || patch >= 66));
}

function hookConfig(): object {
  const win = (p: string) => p.replace(/\//g, "\\");
  const nix = (p: string) => p.replace(/\\/g, "/");
  const bun = bunExe();
  const cmd = (mode: string, matcher?: string) => {
    const entry: Record<string, unknown> = {
      type: "command",
      powershell: `& '${win(bun)}' '${win(HOOK)}' ${mode}`,
      bash: `'${nix(bun)}' '${nix(HOOK)}' ${mode}`,
    };
    if (matcher) entry.matcher = matcher; // regex on toolName, anchored ^(?:…)$ by Copilot CLI
    return entry;
  };
  const hooks: Record<string, unknown> = {
    userPromptSubmitted: [cmd("user-prompt")],
    preToolUse: [cmd("pre-tool", "(?:.*brain_create|task)")],
    postToolUse: [cmd("post-tool")],
    agentStop: [cmd("agent-stop")],
    subagentStop: [cmd("subagent-stop")],
    subagentStart: [cmd("subagent-start")],
  };
  if (!supportsPerPromptContext()) hooks.sessionStart = [cmd("session-start")];
  return {
    version: 1,
    hooks,
  };
}

// Write the Cairn-owned hook file. Compare the complete desired config so existing installs are upgraded
// when events are added or removed instead of being left stale by an old string marker.
export async function installCopilotHook(dryRun: boolean): Promise<Result> {
  const path = copilotHookPath();
  const desired = `${JSON.stringify(hookConfig(), null, 2)}\n`;
  if (existsSync(path) && (await readFile(path, "utf8")) === desired) return "already";
  if (dryRun) return "would-add";
  mkdirSync(dirname(path), { recursive: true });
  await writeFile(path, desired, "utf8");
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
