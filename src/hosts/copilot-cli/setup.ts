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

// Six events — the full set Copilot CLI (v1.0.66+) honors for Cairn's brain workflow:
//   sessionStart        → a baseline workflow copy, once per session.
//   userPromptSubmitted → the full workflow at TURN START, on every prompt (Claude UserPromptSubmit parity).
//                         NOTE: the published hooks reference says this event's output is "not processed",
//                         but a live marker test on v1.0.66 proved additionalContext here DOES reach the
//                         model. sessionStart stays as a fallback in case a future version regresses.
//   preToolUse          → gate a brain_create (deny closed-question / root-only-branch); matcher-scoped
//                         to brain_create so it never fires on ordinary tools.
//   postToolUse         → entry-format/orchestrate + per-tool reminders after a brain_* or Task call; also
//                         the skill_review trigger (review the whole turn log when the agent signals a
//                         finished deliverable — catches backgrounded subagent output).
//   agentStop           → the Stop equivalent: decision:"block" re-runs the turn (turn-reminder when brain
//                         unused; skill-review when a skill was used but not submitted via skill_review).
//                         Auto-learns the turn as a FALLBACK unless skill_review already reviewed it.
//   subagentStart       → additionalContext prepended to a spawned subagent's own prompt.
// hook.ts picks the mode from its argv.
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
  return {
    version: 1,
    hooks: {
      sessionStart: [cmd("session-start")],
      userPromptSubmitted: [cmd("user-prompt")],
      preToolUse: [cmd("pre-tool", ".*brain_create")],
      postToolUse: [cmd("post-tool")],
      agentStop: [cmd("agent-stop")],
      subagentStop: [cmd("subagent-stop")],
      subagentStart: [cmd("subagent-start")],
    },
  };
}

// Write the cairn hook file (its own file, so it never collides with the user's other hooks). The
// idempotency marker is "subagent-stop": a file written before the skill-learning events were added lacks
// it and is upgraded in place.
export async function installCopilotHook(dryRun: boolean): Promise<Result> {
  const path = copilotHookPath();
  if (existsSync(path) && (await readFile(path, "utf8")).includes("subagent-stop")) return "already";
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
