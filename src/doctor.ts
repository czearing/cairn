import { existsSync } from "node:fs";
import { access, constants } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { c, sym, line, step } from "./term";
import { readAutoUpdateState } from "./core/auto-update";
import { crashLogPath, recentCrashes } from "./core/crash-guard";
import { autoUpdateEnabled } from "./core/config";

// Preflight, flutter-doctor style: check every dependency the install needs UP FRONT and, for
// each failure, print the exact command that fixes it. A masterwork installer never reports a
// half-configured success — it tells you precisely what is missing and how to repair it.

export interface Check {
  name: string;
  ok: boolean;
  required: boolean; // a failing required check aborts install; optional ones only warn
  detail: string;
  fix?: string;
}

const settingsPath = () =>
  process.env.CAIRN_SETTINGS_PATH || join(homedir(), ".claude", "settings.json");

function firstLine(buf: Uint8Array): string {
  return new TextDecoder().decode(buf).trim().split("\n")[0] ?? "";
}

function probe(cmd: string, args: string[]): string | null {
  const bin = Bun.which(cmd);
  if (!bin) return null;
  try {
    const r = Bun.spawnSync([bin, ...args], { stdout: "pipe", stderr: "pipe" });
    return r.success ? firstLine(r.stdout) : "";
  } catch {
    return "";
  }
}

// Writable if the path exists and is writable, or its nearest existing ancestor is.
async function writable(path: string): Promise<boolean> {
  let p = path;
  while (p && p !== dirname(p) && !existsSync(p)) p = dirname(p);
  try {
    await access(p, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

export async function checks(): Promise<Check[]> {
  const out: Check[] = [];
  const sp = settingsPath();

  // A reader role exported into the shell is inherited by the host CLI and therefore by the MCP
  // server, which then rejects every brain write with an error that reads like an outage but is a
  // setting. The writers now strip it, but a shell that exports it is still worth naming here.
  const readerRole = process.env.CAIRN_READONLY === "1";
  out.push({
    name: "Brain write role",
    ok: !readerRole,
    required: false,
    detail: readerRole
      ? "CAIRN_READONLY=1 is exported in this environment; brain writes are refused in any process that inherits it"
      : "writable",
    fix: readerRole
      ? "unset CAIRN_READONLY (remove it from your shell profile), then restart the host CLI"
      : undefined,
  });

  const bun = probe("bun", ["--version"]);
  out.push({
    name: "Bun runtime",
    ok: bun !== null,
    required: true,
    detail: bun ? `bun ${bun}` : "not found on PATH",
    fix: "curl -fsSL https://bun.sh/install | bash    (Windows: irm bun.sh/install.ps1 | iex)",
  });

  const git = probe("git", ["--version"]);
  out.push({
    name: "Git",
    ok: git !== null,
    required: false,
    detail: git ?? "not found (only needed to update Cairn later)",
    fix: "Install Git: https://git-scm.com/downloads",
  });

  const claude = Bun.which("claude");
  out.push({
    name: "Claude Code CLI",
    ok: Boolean(claude),
    required: false,
    detail: claude ? claude.replace(/\\/g, "/") : "not found; brain_* tools can't auto-register",
    fix: "Install Claude Code, then re-run `cairn install` (a manual register line is printed at the end).",
  });

  const w = await writable(sp);
  out.push({
    name: "Settings writable",
    ok: w,
    required: true,
    detail: w ? sp.replace(/\\/g, "/") : `cannot write ${sp.replace(/\\/g, "/")}`,
    fix: `Make sure you own ${dirname(sp).replace(/\\/g, "/")} and it is writable, then re-run.`,
  });

  const auto = autoUpdateEnabled();
  const stamp = readAutoUpdateState();
  // "Did this machine actually get the fix?" is the question this line has to answer on sight, so it
  // names the next scheduled check too: a skipped (dirty checkout) or failed install looks identical
  // to a healthy one if you only report when it last looked.
  const next = stamp.nextCheckTs ? `; next check ${new Date(stamp.nextCheckTs).toISOString()}` : "";
  const seen = stamp.lastCheckTs
    ? `last check ${new Date(stamp.lastCheckTs).toISOString()}${stamp.lastStatus ? ` (${stamp.lastStatus}${stamp.lastReason ? `: ${stamp.lastReason}` : ""})` : ""}${stamp.consecutiveFailures ? `; ${stamp.consecutiveFailures} consecutive failure(s), retrying with backoff` : ""}${next}`
    : "no check recorded yet; the next turn will run one";
  out.push({
    name: "Auto-update",
    ok: auto && stamp.lastStatus !== "skipped" && stamp.lastStatus !== "failed",
    required: false,
    detail: auto ? seen : "disabled; this install will not receive published fixes on its own",
    fix: auto
      ? "A skipped check means the checkout is dirty or diverged: commit, stash, or push local work so fast-forward can apply."
      : 'Re-enable with CAIRN_AUTO_UPDATE=1 or remove "autoUpdate": false from ~/.cairn/config.json.',
  });

  const crashes = recentCrashes();
  out.push({
    name: "Background faults",
    ok: !crashes,
    required: false,
    detail: crashes
      ? `${crashes.count} caught since the log was last cleared; latest ${crashes.latest}`
      : "none recorded",
    fix: crashes
      ? `Cairn stayed up and recorded these instead of dropping the connection. Full stacks: ${crashLogPath()}`
      : undefined,
  });

  return out;
}

// Print a check list. Returns true when every REQUIRED check passed.
export function report(list: Check[]): boolean {
  for (const ck of list) {
    const mark = ck.ok ? sym.ok : ck.required ? sym.bad : sym.warn;
    step(`${mark} ${ck.name.padEnd(20)} ${c.dim(ck.detail)}`);
    if (!ck.ok && ck.fix) step(`    ${sym.arrow} ${ck.fix}`);
  }
  return list.filter((ck) => ck.required).every((ck) => ck.ok);
}

// `cairn doctor` entrypoint: run + print, exit non-zero if a required check fails.
export async function doctor(): Promise<boolean> {
  line(c.bold("\nCairn doctor: environment preflight\n"));
  const ok = report(await checks());
  line();
  line(ok ? `${sym.ok} ${c.green("Ready to install.")}` : `${sym.bad} ${c.red("Fix the items above, then re-run.")}`);
  return ok;
}
