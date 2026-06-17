import { existsSync } from "node:fs";
import { copyFile, readFile, writeFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Settings } from "./install.types";
import { c, sym, line, step } from "./term";
import { copilotTargeted, removeCopilot } from "./hosts/copilot-cli/setup";

// Clean reversal of `cairn install`: strip Cairn's hooks from settings.json and remove the MCP
// registration. clig.dev calls for a prominent, real uninstall path — no hand-editing JSON.

const MARKER = "cairn";
const settingsPath = () =>
  process.env.CAIRN_SETTINGS_PATH || join(homedir(), ".claude", "settings.json");

async function removeHooks(): Promise<string[]> {
  const path = settingsPath();
  if (!existsSync(path)) return [];
  const settings: Settings = JSON.parse(await readFile(path, "utf8"));
  const hooks = settings.hooks ?? {};
  const cleared: string[] = [];

  for (const event of Object.keys(hooks)) {
    const before = hooks[event]!.length;
    hooks[event] = hooks[event]!.filter((g) => !g.hooks.some((h) => h.command.includes(MARKER)));
    if (hooks[event]!.length !== before) cleared.push(event);
    if (hooks[event]!.length === 0) delete hooks[event];
  }

  if (cleared.length) {
    await copyFile(path, `${path}.bak`);
    await writeFile(path, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  }
  return cleared;
}

const mcpName = () => process.env.CAIRN_MCP_NAME || "cairn";
const agentPath = () => process.env.CAIRN_AGENT_PATH || join(homedir(), ".claude", "agents", "cairn.md");

// Remove the generated `cairn` subagent definition (only ours — it carries the dispatch command).
async function removeSubagent(): Promise<boolean> {
  const path = agentPath();
  if (!existsSync(path) || !(await readFile(path, "utf8")).includes("dispatch.ts")) return false;
  await rm(path);
  return true;
}

function removeMcp(): "removed" | "absent" | "no-cli" | "skipped" {
  if (process.env.CAIRN_SKIP_MCP) return "skipped";
  const claude = Bun.which("claude");
  if (!claude) return "no-cli";
  const r = Bun.spawnSync([claude, "mcp", "remove", mcpName(), "--scope", "user"], {
    stdout: "ignore",
    stderr: "ignore",
  });
  return r.exitCode === 0 ? "removed" : "absent";
}

export async function uninstall(): Promise<void> {
  line(c.bold("\nCairn uninstall\n"));
  const cleared = await removeHooks();
  step(
    cleared.length
      ? `${sym.ok} Removed hooks: ${cleared.join(", ")} ${c.dim("(.bak written)")}`
      : `${sym.dot} No Cairn hooks were present.`
  );

  const mcp = removeMcp();
  step(
    mcp === "removed"
      ? `${sym.ok} Unregistered the MCP server 'cairn'.`
      : mcp === "absent"
        ? `${sym.dot} MCP server 'cairn' was not registered.`
        : mcp === "skipped"
          ? `${sym.dot} Skipped MCP removal (CAIRN_SKIP_MCP set).`
          : `${sym.warn} Claude CLI not found. Remove manually: ${c.cyan(`claude mcp remove ${mcpName()} --scope user`)}`
  );

  step(
    (await removeSubagent())
      ? `${sym.ok} Removed the ${c.cyan("cairn")} subagent definition.`
      : `${sym.dot} No cairn subagent definition present.`
  );

  if (copilotTargeted()) {
    const { mcp: cm, hook: ch } = await removeCopilot();
    const parts = [cm && "mcp-config", ch && "hook"].filter(Boolean).join(" + ");
    step(parts ? `${sym.ok} Removed Copilot CLI config (${parts}).` : `${sym.dot} No Copilot CLI config present.`);
  }

  line();
  line(`${sym.ok} ${c.green("Cairn removed from Claude Code.")} Your brain at ${c.cyan("~/.cairn/cairn.db")} is untouched.`);
  line(c.dim("   Delete it yourself if you also want to erase stored memories."));
  line(c.dim("   Restart Claude Code to drop the hooks and brain_* tools."));
}
