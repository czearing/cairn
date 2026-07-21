import { closeSync, existsSync, mkdirSync, openSync, readdirSync, statSync, unlinkSync, utimesSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { config } from "../core/config";

const HEARTBEAT_MS = 1_000;
const STALE_MS = 4_000;

const prefix = (parentPid = process.ppid): string => `${basename(config.dbPath)}.mcp-${parentPid}-`;
const markerPath = (pid = process.pid, parentPid = process.ppid): string =>
  join(dirname(config.dbPath), `${prefix(parentPid)}${pid}`);

function touch(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path)) {
    const now = new Date();
    utimesSync(path, now, now);
    return;
  }
  closeSync(openSync(path, "w"));
}

export function startMcpPresence(): () => void {
  const path = markerPath();
  const beat = () => {
    try { touch(path); } catch { /* presence must never crash MCP */ }
  };
  beat();
  const timer = setInterval(beat, HEARTBEAT_MS);
  timer.unref();
  const stop = () => {
    clearInterval(timer);
    try { unlinkSync(path); } catch { /* already removed */ }
  };
  process.once("exit", stop);
  return stop;
}

export function mcpAvailable(now = Date.now(), parentPid = process.ppid): boolean {
  const forced = process.env.CAIRN_MCP_AVAILABLE;
  if (forced === "0") return false;
  if (forced === "1") return true;
  try {
    const dir = dirname(config.dbPath);
    const expected = prefix(parentPid);
    for (const name of readdirSync(dir)) {
      if (!name.startsWith(expected)) continue;
      const path = join(dir, name);
      if (statSync(path).mtimeMs >= now - STALE_MS) return true;
      try { unlinkSync(path); } catch { /* another process may own cleanup */ }
    }
  } catch { /* missing or unreadable presence directory means unavailable */ }
  return false;
}
