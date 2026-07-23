import { existsSync, writeFileSync, chmodSync, mkdirSync } from "node:fs";
import { copyFile, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { Settings } from "./install.types";
import { checks, report } from "./doctor";
import { verify } from "./verify";
import { c, sym, line, step } from "./term";
import {
  copilotTargeted,
  installCopilotMcp,
  installCopilotHook,
  copilotMcpPath,
} from "./hosts/copilot-cli/setup";
import { libsqlEnv } from "./libsql-env";

// Registers Cairn with Claude Code AND GitHub Copilot CLI as a measured, verified flow:
//   1 preflight  2 Claude hooks(+.bak)  3 Claude MCP  4 Copilot CLI  5 cairn cmd  6 warm+verify  7 summary
// Idempotent; writes a .bak of settings.json on first change.
// Set CAIRN_SETTINGS_PATH (Claude) or CAIRN_COPILOT_MCP_PATH/CAIRN_COPILOT_HOOK_PATH (Copilot) to
// target different files (used by tests). CAIRN_SKIP_COPILOT skips the Copilot phase.

const MARKER = "cairn";
const ROOT = resolve(import.meta.dir, "..");
const DISPATCH = join(ROOT, "src", "hosts", "claude-code", "dispatch.ts").replace(/\\/g, "/");
const SERVER = join(ROOT, "src", "mcp", "server.ts").replace(/\\/g, "/");
const CLI = join(ROOT, "src", "cli.ts").replace(/\\/g, "/");
const AGENT_BODY = join(ROOT, "prompts", "agent-system.md");

const settingsPath = () =>
  process.env.CAIRN_SETTINGS_PATH || join(homedir(), ".claude", "settings.json");
// Subagent definition path, overridable so tests/sandbox don't touch the real ~/.claude/agents.
const agentPath = () => process.env.CAIRN_AGENT_PATH || join(homedir(), ".claude", "agents", "cairn.md");
const bun = () => (Bun.which("bun") ?? "bun").replace(/\\/g, "/");
// Server name is overridable so a sandbox can rehearse the real `claude mcp` path under a
// throwaway name (e.g. CAIRN_MCP_NAME=cairn-sandbox) without touching the live `cairn` registration.
const mcpName = () => process.env.CAIRN_MCP_NAME || "cairn";

// Phase 2 — merge our hooks, skipping any already present. Returns the events newly added.
// In dryRun mode nothing is written; `added` reports what WOULD change.
// SubagentStop is a PARENT-session event that fires when a Task subagent finishes; we register it so the
// skill learner runs over the subagent's own transcript (e.g. a short-story reviewer becomes its own skill).
// Without it the SubagentStop branch in dispatch is dead and subagent work is never learned.
async function installHooks(dryRun: boolean): Promise<{ added: string[]; bak: boolean }> {
  const path = settingsPath();
  const command = `"${bun()}" "${DISPATCH}"`;
  const settings: Settings = existsSync(path) ? JSON.parse(await readFile(path, "utf8")) : {};
  const hooks = settings.hooks ?? (settings.hooks = {});

  const added: string[] = [];
  for (const event of ["UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop", "SubagentStop"]) {
    const list = hooks[event] ?? (hooks[event] = []);
    if (list.some((g) => g.hooks.some((h) => h.command.includes(MARKER)))) continue;
    list.push({ hooks: [{ type: "command", command }] });
    added.push(event);
  }

  let bak = false;
  if (added.length && !dryRun) {
    if (existsSync(path)) {
      await copyFile(path, `${path}.bak`);
      bak = true;
    }
    await writeFile(path, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  }
  return { added, bak };
}

// Phase 3 — register the MCP server at user scope, but probe first so a re-run is a no-op, not an
// error. Any CAIRN_LIBSQL_* vars in the environment are baked into the registration as `-e` flags, so
// `cairn install` is all a new device needs to join cloud sync. If the server is already registered
// but lacks those creds (e.g. sync was set up after the fact), it is re-registered to add them.
// In dryRun mode it only probes and reports what WOULD happen. Returns what happened.
function registerMcp(dryRun: boolean): "registered" | "updated" | "already" | "failed" | "no-cli" | "would-register" {
  const claude = Bun.which("claude");
  if (!claude) return "no-cli";
  const env = libsqlEnv();
  const envArgs = Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
  const addArgs = [claude, "mcp", "add", mcpName(), "--scope", "user", ...envArgs, "--", bun(), SERVER];
  const exists = Bun.spawnSync([claude, "mcp", "get", mcpName()], { stdout: "pipe", stderr: "ignore" });
  if (exists.exitCode === 0) {
    // Already registered. Re-register only to fold in cloud-sync creds that aren't recorded yet.
    const hasSync = (exists.stdout?.toString() ?? "").includes("CAIRN_LIBSQL_URL");
    if (!Object.keys(env).length || hasSync) return "already";
    if (dryRun) return "would-register";
    Bun.spawnSync([claude, "mcp", "remove", mcpName(), "--scope", "user"], { stdout: "ignore", stderr: "ignore" });
    const u = Bun.spawnSync(addArgs, { stdout: "ignore", stderr: "ignore" });
    return u.exitCode === 0 ? "updated" : "failed";
  }
  if (dryRun) return "would-register";
  const r = Bun.spawnSync(addArgs, { stdout: "ignore", stderr: "ignore" });
  return r.exitCode === 0 ? "registered" : "failed";
}

// Phase 4 — drop a global `cairn` shim into bun's own bin dir (already on PATH, so no PATH edits),
// instead of the flaky `bun link`. Writes a .cmd for Windows shells + a bash shim for Git Bash/Unix.
function linkCommand(dryRun: boolean): { path: string; created: boolean; onBunPath: boolean } {
  const bunExe = Bun.which("bun") ?? "bun";
  // CAIRN_BIN_DIR lets tests/sandbox redirect the shim to a temp dir; default is bun's own bin dir,
  // which the bun installer already puts on PATH.
  const binDir = process.env.CAIRN_BIN_DIR || dirname(bunExe);
  const onBunPath = Boolean(process.env.CAIRN_BIN_DIR) || binDir.replace(/\\/g, "/").endsWith("/.bun/bin");
  const isWin = process.platform === "win32";
  const target = join(binDir, isWin ? "cairn.cmd" : "cairn").replace(/\\/g, "/");
  if (dryRun) return { path: target, created: false, onBunPath };
  const bash = `#!/usr/bin/env bash\nexec "${bunExe.replace(/\\/g, "/")}" "${CLI}" "$@"\n`;
  if (isWin) {
    writeFileSync(target, `@echo off\r\n"${bunExe}" "${CLI.replace(/\//g, "\\")}" %*\r\n`, "utf8");
    writeFileSync(join(binDir, "cairn"), bash, "utf8"); // Git Bash / WSL on the same PATH
  } else {
    writeFileSync(target, bash, "utf8");
    chmodSync(target, 0o755);
  }
  return { path: target, created: true, onBunPath };
}

// Persist the cloud-sync settings to ~/.cairn/config.json when they are present in the environment.
// This is the shared source of truth that lets the short-lived hook processes (which don't inherit
// the MCP server's env) see that sync is on and read the same replica the server maintains. The
// secret lives only in this local file, never in the repo.
function writeSyncConfig(dryRun: boolean): "written" | "would-write" | "none" {
  const env = libsqlEnv();
  if (!env.CAIRN_LIBSQL_URL || !env.CAIRN_LIBSQL_TOKEN) return "none";
  if (dryRun) return "would-write";
  const path = process.env.CAIRN_CONFIG_PATH || join(homedir(), ".cairn", "config.json");
  const libsql: Record<string, string | number> = { url: env.CAIRN_LIBSQL_URL, token: env.CAIRN_LIBSQL_TOKEN };
  if (env.CAIRN_LIBSQL_SYNC_PERIOD) libsql.syncPeriod = Number(env.CAIRN_LIBSQL_SYNC_PERIOD);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ libsql }, null, 2)}\n`, "utf8");
  return "written";
}

// Install a `cairn` subagent definition so spawned subagents AND agent-team teammates run under the
// SAME injected brain prompts. Its frontmatter hooks run this same dispatch (SessionStart injects the
// workflow, PostToolUse the state-specific reminders, Stop→SubagentStop the completion gate);
// its body carries the policy for the agent-teams path, where only the body is appended. Idempotent.
async function installSubagent(dryRun: boolean): Promise<"written" | "would-write" | "already"> {
  const path = agentPath();
  const command = `"${bun()}" "${DISPATCH}"`;
  const group = `    - hooks:\n        - type: command\n          command: '${command}'`;
  const frontmatter =
    [
      "---",
      "name: cairn",
      "description: >-",
      "  A worker wired into the shared Cairn brain: it searches the brain before acting and records",
      "  atomic, cited findings. Use for any research, build, or debug subtask that should read and",
      "  grow the team's memory.",
      "hooks:",
      `  SessionStart:\n${group}`,
      `  PreToolUse:\n${group}`,
      `  PostToolUse:\n${group}`,
      `  Stop:\n${group}`,
      "---",
      "",
    ].join("\n");
  const content = frontmatter + (await readFile(AGENT_BODY, "utf8"));
  if (existsSync(path) && (await readFile(path, "utf8")) === content) return "already";
  if (dryRun) return "would-write";
  mkdirSync(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");
  return "written";
}

export async function install(opts: { dryRun?: boolean } = {}): Promise<void> {
  const dryRun = opts.dryRun ?? false;
  line(c.bold(`\nInstalling Cairn for Claude Code + GitHub Copilot CLI${dryRun ? c.yellow("  [DRY RUN: nothing is written]") : ""}\n`));

  // ── Phase 1: preflight ────────────────────────────────────────────────────────────────────
  line(c.dim("1/7  Preflight"));
  if (!report(await checks())) {
    line();
    line(`${sym.bad} ${c.red("Required checks failed.")} Fix the items above and re-run ${c.cyan("cairn install")}.`);
    process.exitCode = 1;
    return;
  }
  if (!dryRun) {
    const { skillCatalog } = await import("./skill/store");
    skillCatalog();
  }

  // ── Phase 2: hooks ────────────────────────────────────────────────────────────────────────
  line(c.dim("\n2/7  Claude Code prompt-injection hooks"));
  const { added, bak } = await installHooks(dryRun);
  const wouldOr = dryRun ? "Would add" : "Added";
  step(added.length ? `${sym.ok} ${wouldOr}: ${added.join(", ")}` : `${sym.dot} Already installed. No change.`);

  // ── Phase 3: MCP registration ─────────────────────────────────────────────────────────────
  line(c.dim("\n3/7  Claude Code MCP server (brain_* tools)"));
  const mcp = process.env.CAIRN_SKIP_MCP ? "skipped" : registerMcp(dryRun);
  const manual = `claude mcp add ${mcpName()} --scope user -- "${bun()}" "${SERVER}"`;
  if (mcp === "skipped") step(`${sym.dot} Skipped (CAIRN_SKIP_MCP set).`);
  else if (mcp === "registered") step(`${sym.ok} Registered '${mcpName()}' at user scope.${Object.keys(libsqlEnv()).length ? c.dim(" (cloud sync wired in)") : ""}`);
  else if (mcp === "updated") step(`${sym.ok} Updated '${mcpName()}' with cloud-sync credentials.`);
  else if (mcp === "would-register") step(`${sym.dot} Would register '${mcpName()}' at user scope.`);
  else if (mcp === "already") step(`${sym.dot} Already registered. No change.`);
  else if (mcp === "no-cli") {
    step(`${sym.warn} Claude CLI not found. Register it yourself once Claude Code is installed:`);
    step(`    ${c.cyan(manual)}`);
  } else {
    step(`${sym.warn} Auto-register failed. Run it manually:`);
    step(`    ${c.cyan(manual)}`);
  }
  const synced = writeSyncConfig(dryRun);
  if (synced === "written") step(`${sym.ok} Cloud sync enabled — wrote ${c.dim("~/.cairn/config.json")} ${c.dim("(shared by the server + hooks)")}.`);
  else if (synced === "would-write") step(`${sym.dot} Would write cloud-sync config to ~/.cairn/config.json.`);
  else step(`${sym.dot} Cloud sync ${c.bold("off")} ${c.dim("(local brain). Set CAIRN_LIBSQL_URL + CAIRN_LIBSQL_TOKEN and re-run to share one brain across devices.")}`);

  const agent = await installSubagent(dryRun);
  if (agent === "written") step(`${sym.ok} Installed the ${c.cyan("cairn")} subagent ${c.dim("(~/.claude/agents/cairn.md — same brain prompts for spawned agents/teams)")}.`);
  else if (agent === "would-write") step(`${sym.dot} Would install the cairn subagent at ~/.claude/agents/cairn.md.`);
  else step(`${sym.dot} cairn subagent already installed. No change.`);

  // ── Phase 4: GitHub Copilot CLI (MCP tools + full injection hook set) ─────────────────────────
  line(c.dim("\n4/7  GitHub Copilot CLI"));
  if (!copilotTargeted()) {
    step(
      process.env.CAIRN_SKIP_COPILOT
        ? `${sym.dot} Skipped (CAIRN_SKIP_COPILOT set).`
        : `${sym.dot} Copilot CLI not detected — skipped. Re-run ${c.cyan("cairn install")} after installing it.`
    );
  } else {
    const cmcp = await installCopilotMcp(dryRun);
    step(
      cmcp === "added" ? `${sym.ok} Registered brain_* tools in ${c.dim("~/.copilot/mcp-config.json")}.`
        : cmcp === "would-add" ? `${sym.dot} Would register brain_* tools in ~/.copilot/mcp-config.json.`
          : `${sym.dot} brain_* tools already registered. No change.`
    );
    const chook = await installCopilotHook(dryRun);
    step(
      chook === "added" ? `${sym.ok} Installed the injection hooks ${c.dim("(userPromptSubmitted, preToolUse, postToolUse, agentStop, subagentStart, subagentStop)")}.`
        : chook === "would-add" ? `${sym.dot} Would install the injection hooks (userPromptSubmitted, preToolUse, postToolUse, agentStop, subagentStart, subagentStop).`
          : `${sym.dot} Injection hooks already installed. No change.`
    );
  }

  // ── Phase 5: global `cairn` command ─────────────────────────────────────────────────────────
  line(c.dim("\n5/7  Global `cairn` command"));
  const link = linkCommand(dryRun);
  if (dryRun) step(`${sym.dot} Would create ${c.cyan("cairn")} at ${c.dim(link.path)}`);
  else step(`${sym.ok} ${c.cyan("cairn")} installed at ${c.dim(link.path)}`);
  if (!link.onBunPath) step(`    ${sym.warn} ${c.dim(`If 'cairn' isn't found, add ${dirname(link.path)} to your PATH.`)}`);

  // ── Phase 6: warm the model and prove a real create -> recall round-trip ─────────────────────
  line(c.dim("\n6/7  Downloading the embedding model + verifying end-to-end"));
  step(c.dim("(semantic search needs a local embedding model — a ~25MB binary, downloaded ONCE here so your first search is instant, never mid-use)"));
  const v = process.env.CAIRN_SKIP_VERIFY
    ? { ok: true, recalled: true, warmMs: 0, smokeMs: 0 }
    : await verify();
  if (process.env.CAIRN_SKIP_VERIFY) {
    step(`${sym.dot} Skipped (CAIRN_SKIP_VERIFY set).`);
  } else if (v.ok) {
    step(`${sym.ok} Brain verified: created & recalled a memory. ${c.dim(`warm ${v.warmMs}ms · recall ${v.smokeMs}ms`)}`);
  } else {
    step(`${sym.warn} ${c.yellow("Could not verify the brain end-to-end.")} ${c.dim(v.error ?? "")}`);
    step(`    ${sym.arrow} Check connectivity (the local model downloads once), then run ${c.cyan("cairn verify")}.`);
  }

  // ── Phase 7: what changed + next step ───────────────────────────────────────────────────────
  line(c.dim("\n7/7  Summary"));
  step(`${sym.dot} settings.json  ${c.dim(settingsPath().replace(/\\/g, "/") + (bak ? "  (.bak written)" : ""))}`);
  if (copilotTargeted()) step(`${sym.dot} copilot config ${c.dim(copilotMcpPath().replace(/\\/g, "/") + " + hooks/cairn.json")}`);
  step(`${sym.dot} brain          ${c.dim(join(homedir(), ".cairn", "cairn.db").replace(/\\/g, "/"))}`);
  step(`${sym.dot} commands       ${c.dim("cairn doctor · cairn verify · cairn update · cairn uninstall")}`);
  step(`${sym.dot} viewer         ${c.dim("cairn ui  →  http://localhost:3737")}`);

  line();
  if (dryRun) {
    line(`${sym.ok} ${c.green(c.bold("Dry run complete."))} Nothing was written. Re-run without ${c.cyan("--dry-run")} to apply.`);
  } else {
    line(`${sym.ok} ${c.green(c.bold("Done."))} ${c.bold("Restart Claude Code")} (or reconnect the cairn MCP server), then ask it something. It will recall and grow the brain.`);
    if (copilotTargeted()) line(c.dim("   GitHub Copilot CLI picks up the brain on its next session — new `copilot` sessions recall automatically."));
    line(c.dim("   (New terminal? The `cairn` command is ready. Try `cairn doctor`.)"));
  }
}
