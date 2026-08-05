import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { config } from "./config";

// Why a long-lived Cairn process died used to be unrecoverable. Bun terminates on the first
// unhandled rejection or uncaught exception anywhere in the process, including inside a dependency
// or a background timer, and an MCP host reports that only as "MCP error -32000: Connection closed"
// with no stack, no exit code, and nothing on disk. See issue #2, where the reporter could describe
// the symptom precisely and still could not name the cause, because no evidence survived the death.
//
// This installs the missing backstop. A stray rejection is recorded and the process keeps serving:
// every tool call is already wrapped independently, so one failed background promise should never
// cost an agent its memory. Writes go to stderr, which MCP hosts capture into their own logs, and
// to a bounded file next to the brain so the trail outlives the session.

const MAX_LOG_BYTES = 256 * 1024;
let installed = false;

export function crashLogPath(): string {
  return join(dirname(config.dbPath), "crash.log");
}

function record(role: string, kind: string, error: unknown): void {
  const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
  const entry = `[${new Date().toISOString()}] ${role} pid=${process.pid} ${kind}\n${detail}\n\n`;
  // stderr first: it is the channel a host already captures, and it is never the MCP protocol
  // channel, so writing here cannot corrupt the stdio framing the way stdout would.
  process.stderr.write(`[cairn] ${kind} in ${role}: ${detail}\n`);
  try {
    const path = crashLogPath();
    mkdirSync(dirname(path), { recursive: true });
    let size = 0;
    try { size = statSync(path).size; } catch { /* first write, no file yet */ }
    if (size > MAX_LOG_BYTES) writeFileSync(path, "");
    appendFileSync(path, entry);
  } catch { /* a crash log that throws while logging a crash would replace the fault it records */ }
}

/** Keep a long-lived process alive through a stray async fault, and leave evidence of it. */
export function installCrashGuard(role: string): void {
  if (installed) return;
  installed = true;
  process.on("unhandledRejection", (reason) => record(role, "unhandled rejection", reason));
  process.on("uncaughtException", (error) => record(role, "uncaught exception", error));
}

/** What `cairn doctor` reports, so a caught fault is discoverable instead of buried in a file. */
export function recentCrashes(): { count: number; latest: string } | null {
  let text: string;
  try { text = readFileSync(crashLogPath(), "utf8"); } catch { return null; }
  const headers = text.split("\n").filter((l) => l.startsWith("[") && l.includes(" pid="));
  const latest = headers.at(-1);
  return latest ? { count: headers.length, latest } : null;
}
