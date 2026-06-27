import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../core/config";
import { activityPath, readActivity, renderActivity } from "./activity";
import { c, line } from "../term";

// The persistent `cairn skills` window. The user sees it ONCE; it stays open and narrates the background
// learner in real time (which skill was graded, the quality score, whether the master was rewritten). It
// polls the shared activity log rather than holding a handle to the short-lived workers, so any number of
// invisible background runs feed this one visible feed.
//
// Auto-open + singleton: ensureMonitor() opens exactly one window the first time the skill loop runs and
// never a second. A lock file (next to the brain db) holds the LIVE monitor's pid plus a heartbeat ts; a
// monitor is "alive" only if its pid is running AND the heartbeat is fresh, so a crashed monitor is
// re-opened next turn but a healthy one is never duplicated. Set CAIRN_SKILLS_MONITOR=0 to opt out.

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const HEARTBEAT_MS = 5_000;  // the live monitor refreshes its lock this often
const STALE_MS = 20_000;     // a lock not refreshed within this window counts as dead

/** Path to the singleton lock, next to the brain db. Overridable for tests via CAIRN_MONITOR_LOCK. */
export function lockPath(): string {
  return process.env.CAIRN_MONITOR_LOCK || join(dirname(config.dbPath), "skill-monitor.lock");
}

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as { code?: string })?.code === "EPERM"; }
}

/** Is a healthy monitor already running? True only if the lock's pid is alive AND its heartbeat is fresh. */
export function monitorAlive(now: number): boolean {
  try {
    const { pid, ts } = JSON.parse(readFileSync(lockPath(), "utf8")) as { pid: number; ts: number };
    return Boolean(pid) && pidAlive(pid) && now - ts < STALE_MS;
  } catch { return false; }
}

function writeLock(pid: number, now: number): void {
  try {
    const p = lockPath();
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify({ pid, ts: now }));
  } catch { /* lock is best-effort */ }
}

// The bun binary actually running this process, so the spawned window does not depend on `bun` being on
// the hook's PATH (it often is not under Claude Code). Falls back to the platform name if unavailable.
const monitorBin = (): string => process.execPath || (process.platform === "win32" ? "bun.exe" : "bun");
const cliPath = (): string => fileURLToPath(new URL("../cli.ts", import.meta.url));

const safeExists = (p: string): boolean => { try { return existsSync(p); } catch { return false; } };

// Launch the monitor in its own visible window. The reliable path on Windows is to open Windows Terminal:
// `cmd /c start "" wt.exe new-tab ...`. cmd's `start` resolves the wt.exe app-execution alias (which
// CreateProcess/spawn cannot launch directly), and Windows Terminal is a GUI app, so it always shows a
// window regardless of the launching process having no console (the Stop hook does not). When Windows
// Terminal is absent, fall back to start'ing the monitor as a bare console (shown subject to the user's
// default-terminal setting). The monitor titles its window "cairn skills" via --title and process.title.
function openConsole(): void {
  const bin = monitorBin(), cli = cliPath();
  if (process.platform !== "win32") {
    spawn(bin, [cli, "skills"], { detached: true, stdio: "ignore" }).unref();
    return;
  }
  const la = process.env.LOCALAPPDATA;
  const hasWt = !!la && safeExists(`${la}\\Microsoft\\WindowsApps\\wt.exe`);
  const args = hasWt
    ? ["/c", "start", "", "wt.exe", "new-tab", "--title", "cairn skills", bin, cli, "skills"]
    : ["/c", "start", "cairn skills", bin, cli, "skills"];
  spawn("cmd.exe", args, { detached: true, stdio: "ignore", windowsHide: false }).unref();
}

/** Open ONE monitor window if none is alive (singleton). Best-effort and gated by CAIRN_SKILLS_MONITOR.
 *  Returns whether it launched one. A short claim under the launcher's pid dedupes the brief gap before the
 *  new monitor writes its own lock, so two near-simultaneous turns don't both open a window. */
export function ensureMonitor(now: number): boolean {
  if (process.env.CAIRN_SKILLS_MONITOR === "0") return false;
  if (monitorAlive(now)) return false;
  try {
    writeLock(process.pid, now); // claim: marks "starting" until the monitor overwrites with its own pid
    openConsole();
    return true;
  } catch { return false; }
}

/** The header shown once at the top of the monitor: what this window is, that it is live, how to read it. */
export function monitorHeader(): string {
  return [
    c.bold(c.cyan("✶ cairn skills")) + c.dim("  the background learner, in plain sight"),
    "  " + c.green("● online") + c.dim(", listening for background runs — leave this open (Ctrl-C to close)"),
    "  " + c.dim("quality ") + c.red("low") + c.dim(" → ") + c.yellow("ok") + c.dim(" → ") + c.green("masterwork"),
    "  " + c.dim(activityPath().replace(/\\/g, "/")),
    "",
  ].join("\n");
}

/** Run the monitor: claim the singleton lock + heartbeat, print the header, replay the recent backlog, then
 *  poll for and render new events. Loops until killed. With { once: true } it prints the current state and
 *  returns without taking the lock (tests, and a non-watching `cairn skills --once`). */
export async function runMonitor(opts: { intervalMs?: number; once?: boolean } = {}): Promise<void> {
  const interval = opts.intervalMs ?? 700;
  try { process.title = "cairn skills"; } catch { /* title is cosmetic */ } // label the console/tab window
  line(monitorHeader());

  const backlog = readActivity();
  for (const ev of backlog.slice(-15)) line(renderActivity(ev));
  if (!backlog.length) line(c.dim("  waiting for the first skill to form… nothing learned yet."));
  let printed = backlog.length;
  if (opts.once) return;

  // Own the singleton lock for as long as this window lives; clear it on exit so the next turn re-opens.
  writeLock(process.pid, Date.now());
  const hb = setInterval(() => writeLock(process.pid, Date.now()), HEARTBEAT_MS);
  const cleanup = (): never => { clearInterval(hb); try { rmSync(lockPath()); } catch { /* gone */ } process.exit(0); };
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  for (;;) {
    await sleep(interval);
    const all = readActivity();
    if (all.length < printed) printed = all.length;          // the log was trimmed: resync, don't reprint
    else if (all.length > printed) {
      for (const ev of all.slice(printed)) line(renderActivity(ev));
      printed = all.length;
    }
  }
}
