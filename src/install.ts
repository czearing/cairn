import { existsSync } from "node:fs";
import { copyFile, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { Settings } from "./install.types";

// Registers Cairn with Claude Code: appends hooks to settings.json (prompt injection) and
// registers the MCP server (the brain_* tools). Idempotent; writes a .bak on first change.
// Set CAIRN_SETTINGS_PATH to target a different settings file (used by tests).

const MARKER = "cairn";
const ROOT = resolve(import.meta.dir, "..");
const DISPATCH = join(ROOT, "src", "hosts", "claude-code", "dispatch.ts").replace(/\\/g, "/");
const SERVER = join(ROOT, "src", "mcp", "server.ts").replace(/\\/g, "/");

const settingsPath = () =>
  process.env.CAIRN_SETTINGS_PATH || join(homedir(), ".claude", "settings.json");
const bun = () => (Bun.which("bun") ?? "bun").replace(/\\/g, "/");

async function installHooks(): Promise<string[]> {
  const path = settingsPath();
  const command = `"${bun()}" "${DISPATCH}"`;
  const settings: Settings = existsSync(path) ? JSON.parse(await readFile(path, "utf8")) : {};
  const hooks = settings.hooks ?? (settings.hooks = {});

  const added: string[] = [];
  for (const event of ["UserPromptSubmit", "PostToolUse", "Stop"]) {
    const list = hooks[event] ?? (hooks[event] = []);
    if (list.some((g) => g.hooks.some((h) => h.command.includes(MARKER)))) continue;
    list.push({ hooks: [{ type: "command", command }] });
    added.push(event);
  }
  if (added.length) {
    if (existsSync(path)) await copyFile(path, `${path}.bak`);
    await writeFile(path, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  }
  return added;
}

function registerMcp(): boolean {
  const claude = Bun.which("claude");
  if (!claude) return false;
  const r = Bun.spawnSync([claude, "mcp", "add", "cairn", "--scope", "user", "--", bun(), SERVER], {
    stdout: "ignore",
    stderr: "ignore",
  });
  return r.exitCode === 0;
}

export async function install(): Promise<void> {
  const added = await installHooks();
  console.log(added.length ? `Hooks installed for: ${added.join(", ")}` : "Hooks already installed.");

  if (process.env.CAIRN_SKIP_MCP) {
    console.log("Skipping MCP registration (CAIRN_SKIP_MCP set).");
  } else if (registerMcp()) {
    console.log("MCP server 'cairn' registered with Claude Code (user scope).");
  } else {
    console.log("MCP not auto-registered (claude CLI not found, or already added). Register manually:");
    console.log(`  claude mcp add cairn --scope user -- "${bun()}" "${SERVER}"`);
  }
  console.log("\nDone. Restart Claude Code to load the hooks and the brain_* tools.");
}
