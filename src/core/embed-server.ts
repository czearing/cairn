#!/usr/bin/env bun
// A tiny, self-exiting embedding sidecar. The Claude Code hooks are one-shot processes, so each would
// reload the ~25MB model (measured ~406ms) just to embed one query for skill matching. This server loads the
// model ONCE and serves embeds over localhost (~5ms), and EXITS ITSELF after a short idle period so it never
// lingers as a leftover process. embed.ts spawns it on demand and falls back to in-process embedding whenever
// the server is unreachable, so behavior is never worse than before.
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { writeFileSync, rmSync, mkdirSync, readFileSync } from "node:fs";
import { embedInProcess, sidecarPort } from "./embed";
import { embedModel } from "./embed";

process.env.CAIRN_EMBED_NO_SERVER = "1"; // our own embed calls must stay in-process (never recurse into a server)

const LOCKFILE = join(homedir(), ".cairn", "embed-server.json");
const IDLE_MS = Number(process.env.CAIRN_EMBED_SERVER_IDLE_MS || "120000"); // self-exit after 2 min idle

// Singleton guard: if a SAME-MODEL server is already alive (its lockfile port answers), don't start a second
// one. A server running a DIFFERENT model is NOT deferred to; this server takes over so a model change can't
// leave stale-model vectors being served.
async function sameModelAlive(): Promise<boolean> {
  let port: number | null;
  try { port = sidecarPort(readFileSync(LOCKFILE, "utf8"), embedModel()); } catch { return false; }
  if (!port) return false;
  try {
    const r = await fetch(`http://127.0.0.1:${port}/embed`, { method: "POST", body: JSON.stringify({ text: " " }), signal: AbortSignal.timeout(1000) });
    return r.ok;
  } catch { return false; }
}
if (await sameModelAlive()) process.exit(0);

// Only the lockfile OWNER removes it on exit, so a server that lost a startup race never deletes the winner's
// lockfile (which would make the next caller spawn yet another server).
function cleanup(): void {
  try { if (JSON.parse(readFileSync(LOCKFILE, "utf8")).pid === process.pid) rmSync(LOCKFILE, { force: true }); } catch { /* gone or not ours */ }
}
process.on("exit", cleanup);
process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));

let idle: ReturnType<typeof setTimeout> | undefined;
function resetIdle(): void { if (idle) clearTimeout(idle); idle = setTimeout(() => process.exit(0), IDLE_MS); }

// Warm the model BEFORE announcing readiness, so the first client request is already fast.
await embedInProcess(" ");

const server = Bun.serve({
  port: 0, // ephemeral; the chosen port is published in the lockfile
  hostname: "127.0.0.1",
  async fetch(req) {
    if (new URL(req.url).pathname !== "/embed") return new Response("not found", { status: 404 });
    resetIdle();
    try {
      const { text } = (await req.json()) as { text?: string };
      return Response.json({ vec: await embedInProcess(typeof text === "string" ? text : "") });
    } catch (e) {
      return new Response(String(e), { status: 500 });
    }
  },
});

try { mkdirSync(dirname(LOCKFILE), { recursive: true }); } catch { /* exists */ }
writeFileSync(LOCKFILE, JSON.stringify({ port: server.port, pid: process.pid, model: embedModel() }));
resetIdle();
console.error(`[cairn] embed server warm on 127.0.0.1:${server.port}, idle-exit in ${Math.round(IDLE_MS / 1000)}s`);

// Resolve a simultaneous-startup race: whoever wrote the lockfile LAST is the keeper; any other server that
// raced to start sees a different pid in the lockfile shortly after and steps aside, leaving exactly one.
setTimeout(() => {
  try { if (JSON.parse(readFileSync(LOCKFILE, "utf8")).pid !== process.pid) process.exit(0); } catch { /* keep serving */ }
}, 750);
