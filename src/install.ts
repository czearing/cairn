import { existsSync, writeFileSync, chmodSync } from "node:fs";
import { copyFile, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { Settings } from "./install.types";
import { checks, report } from "./doctor";
import { verify } from "./verify";
import { c, sym, line, step } from "./term";

// Registers Cairn with Claude Code as a measured, verified flow (not a hopeful one):
//   1 preflight  2 hooks(+.bak)  3 idempotent MCP register  4 warm model  5 smoke test  6 summary
// Idempotent; writes a .bak of settings.json on first change.
// Set CAIRN_SETTINGS_PATH to target a different settings file (used by tests).

const MARKER = "cairn";
const ROOT = resolve(import.meta.dir, "..");
const DISPATCH = join(ROOT, "src", "hosts", "claude-code", "dispatch.ts").replace(/\\/g, "/");
const SERVER = join(ROOT, "src", "mcp", "server.ts").replace(/\\/g, "/");
const CLI = join(ROOT, "src", "cli.ts").replace(/\\/g, "/");

const settingsPath = () =>
  process.env.CAIRN_SETTINGS_PATH || join(homedir(), ".claude", "settings.json");
const bun = () => (Bun.which("bun") ?? "bun").replace(/\\/g, "/");
// Server name is overridable so a sandbox can rehearse the real `claude mcp` path under a
// throwaway name (e.g. CAIRN_MCP_NAME=cairn-sandbox) without touching the live `cairn` registration.
const mcpName = () => process.env.CAIRN_MCP_NAME || "cairn";

// Phase 2 — merge our four hooks, skipping any already present. Returns the events newly added.
// In dryRun mode nothing is written; `added` reports what WOULD change.
async function installHooks(dryRun: boolean): Promise<{ added: string[]; bak: boolean }> {
  const path = settingsPath();
  const command = `"${bun()}" "${DISPATCH}"`;
  const settings: Settings = existsSync(path) ? JSON.parse(await readFile(path, "utf8")) : {};
  const hooks = settings.hooks ?? (settings.hooks = {});

  const added: string[] = [];
  for (const event of ["UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop"]) {
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
// error. In dryRun mode it only probes and reports what WOULD happen. Returns what happened.
function registerMcp(dryRun: boolean): "registered" | "already" | "failed" | "no-cli" | "would-register" {
  const claude = Bun.which("claude");
  if (!claude) return "no-cli";
  const exists = Bun.spawnSync([claude, "mcp", "get", mcpName()], { stdout: "ignore", stderr: "ignore" });
  if (exists.exitCode === 0) return "already";
  if (dryRun) return "would-register";
  const r = Bun.spawnSync([claude, "mcp", "add", mcpName(), "--scope", "user", "--", bun(), SERVER], {
    stdout: "ignore",
    stderr: "ignore",
  });
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

export async function install(opts: { dryRun?: boolean } = {}): Promise<void> {
  const dryRun = opts.dryRun ?? false;
  line(c.bold(`\nInstalling Cairn for Claude Code${dryRun ? c.yellow("  [DRY RUN: nothing is written]") : ""}\n`));

  // ── Phase 1: preflight ────────────────────────────────────────────────────────────────────
  line(c.dim("1/6  Preflight"));
  if (!report(await checks())) {
    line();
    line(`${sym.bad} ${c.red("Required checks failed.")} Fix the items above and re-run ${c.cyan("cairn install")}.`);
    process.exitCode = 1;
    return;
  }

  // ── Phase 2: hooks ────────────────────────────────────────────────────────────────────────
  line(c.dim("\n2/6  Prompt-injection hooks"));
  const { added, bak } = await installHooks(dryRun);
  const wouldOr = dryRun ? "Would add" : "Added";
  step(added.length ? `${sym.ok} ${wouldOr}: ${added.join(", ")}` : `${sym.dot} Already installed. No change.`);

  // ── Phase 3: MCP registration ─────────────────────────────────────────────────────────────
  line(c.dim("\n3/6  MCP server (brain_* tools)"));
  const mcp = process.env.CAIRN_SKIP_MCP ? "skipped" : registerMcp(dryRun);
  const manual = `claude mcp add ${mcpName()} --scope user -- "${bun()}" "${SERVER}"`;
  if (mcp === "skipped") step(`${sym.dot} Skipped (CAIRN_SKIP_MCP set).`);
  else if (mcp === "registered") step(`${sym.ok} Registered '${mcpName()}' at user scope.`);
  else if (mcp === "would-register") step(`${sym.dot} Would register '${mcpName()}' at user scope.`);
  else if (mcp === "already") step(`${sym.dot} Already registered. No change.`);
  else if (mcp === "no-cli") {
    step(`${sym.warn} Claude CLI not found. Register it yourself once Claude Code is installed:`);
    step(`    ${c.cyan(manual)}`);
  } else {
    step(`${sym.warn} Auto-register failed. Run it manually:`);
    step(`    ${c.cyan(manual)}`);
  }

  // ── Phase 4: global `cairn` command ─────────────────────────────────────────────────────────
  line(c.dim("\n4/6  Global `cairn` command"));
  const link = linkCommand(dryRun);
  if (dryRun) step(`${sym.dot} Would create ${c.cyan("cairn")} at ${c.dim(link.path)}`);
  else step(`${sym.ok} ${c.cyan("cairn")} installed at ${c.dim(link.path)}`);
  if (!link.onBunPath) step(`    ${sym.warn} ${c.dim(`If 'cairn' isn't found, add ${dirname(link.path)} to your PATH.`)}`);

  // ── Phase 5: warm the model and prove a real create -> recall round-trip ─────────────────────
  line(c.dim("\n5/6  Warming the embedding model + verifying end-to-end"));
  step(c.dim("(first run downloads a small local model, so we do it now to keep your first search fast)"));
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

  // ── Phase 6: what changed + next step ───────────────────────────────────────────────────────
  line(c.dim("\n6/6  Summary"));
  step(`${sym.dot} settings.json  ${c.dim(settingsPath().replace(/\\/g, "/") + (bak ? "  (.bak written)" : ""))}`);
  step(`${sym.dot} brain          ${c.dim(join(homedir(), ".cairn", "cairn.db").replace(/\\/g, "/"))}`);
  step(`${sym.dot} commands       ${c.dim("cairn doctor · cairn verify · cairn update · cairn uninstall")}`);
  step(`${sym.dot} viewer         ${c.dim("cairn ui  →  http://localhost:3737")}`);

  line();
  if (dryRun) {
    line(`${sym.ok} ${c.green(c.bold("Dry run complete."))} Nothing was written. Re-run without ${c.cyan("--dry-run")} to apply.`);
  } else {
    line(`${sym.ok} ${c.green(c.bold("Done."))} ${c.bold("Restart Claude Code")}, then ask it something. It will recall and grow the brain.`);
    line(c.dim("   (New terminal? The `cairn` command is ready. Try `cairn doctor`.)"));
  }
}
