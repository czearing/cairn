#!/usr/bin/env bun
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "./config";
import { embedModel } from "./embed";
import {
  ENGINE_PROTOCOL_VERSION,
  engineFingerprint,
  engineLockfile,
  engineStartfile,
  parseEngineLock,
  type EngineIdentity,
  type EngineRequest,
  type EngineResponse,
} from "./engine-protocol";
import { warmSearchEngine, search } from "./search";
import {
  createWithDuplicateCandidates,
  link,
  mutate,
  remove,
  unlink,
} from "./neurons";

process.env.CAIRN_ENGINE_NO_SERVER = "1";

const identity: EngineIdentity = {
  dbPath: config.dbPath,
  model: embedModel(),
};
const fingerprint = engineFingerprint(identity);
const lockfile = engineLockfile(fingerprint);
const startfile = engineStartfile(fingerprint);

async function equivalentServerAlive(): Promise<boolean> {
  let existing;
  try { existing = parseEngineLock(readFileSync(lockfile, "utf8"), fingerprint); }
  catch { return false; }
  if (!existing) return false;
  try {
    const response = await fetch(`http://127.0.0.1:${existing.port}/v1/health`, {
      headers: { authorization: `Bearer ${existing.token}` },
      signal: AbortSignal.timeout(1000),
    });
    return response.ok;
  } catch {
    return false;
  }
}
if (await equivalentServerAlive()) process.exit(0);

const token = randomBytes(32).toString("hex");
const responses = new Map<string, EngineResponse>();
const MAX_RESPONSES = 1000;
const remember = (requestId: string, response: EngineResponse): EngineResponse => {
  responses.set(requestId, response);
  if (responses.size > MAX_RESPONSES) responses.delete(responses.keys().next().value!);
  return response;
};

async function execute(request: EngineRequest): Promise<EngineResponse> {
  const prior = responses.get(request.requestId);
  if (prior) return prior;
  try {
    switch (request.operation) {
      case "search":
        return remember(request.requestId, {
          ok: true,
          result: await search(
            request.payload.query,
            request.telemetry ?? null,
            request.payload.options,
          ),
        });
      case "create":
        return remember(request.requestId, {
          ok: true,
          result: await createWithDuplicateCandidates(
            request.payload.text,
            request.payload.edges,
            request.payload.id,
          ),
        });
      case "mutate":
        return remember(request.requestId, {
          ok: true,
          result: await mutate(request.payload.id, request.payload.patch),
        });
      case "delete":
        return remember(request.requestId, {
          ok: true,
          result: remove(request.payload.id),
        });
      case "link":
        link(request.payload.a, request.payload.b);
        return remember(request.requestId, { ok: true, result: true });
      case "unlink":
        unlink(request.payload.a, request.payload.b);
        return remember(request.requestId, { ok: true, result: true });
    }
  } catch (error) {
    return remember(request.requestId, {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

let idle: ReturnType<typeof setTimeout> | undefined;
const idleMs = Number(process.env.CAIRN_ENGINE_IDLE_MS || "1800000");
const resetIdle = (): void => {
  if (idle) clearTimeout(idle);
  idle = setTimeout(() => process.exit(0), idleMs);
};

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    if (request.headers.get("authorization") !== `Bearer ${token}`) {
      return new Response("unauthorized", { status: 401 });
    }
    resetIdle();
    const pathname = new URL(request.url).pathname;
    if (pathname === "/v1/health") {
      return Response.json({ protocol: ENGINE_PROTOCOL_VERSION, fingerprint, pid: process.pid });
    }
    if (pathname !== "/v1/execute" || request.method !== "POST") {
      return new Response("not found", { status: 404 });
    }
    try {
      const body = await request.json() as EngineRequest;
      if (
        !body?.requestId
        || !["search", "create", "mutate", "delete", "link", "unlink"].includes(body.operation)
      ) {
        return Response.json({ ok: false, error: "invalid engine request" } satisfies EngineResponse);
      }
      return Response.json(await execute(body));
    } catch (error) {
      return Response.json({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      } satisfies EngineResponse);
    }
  },
});

const ownership = JSON.stringify({
  protocol: ENGINE_PROTOCOL_VERSION,
  port: server.port,
  pid: process.pid,
  token,
  fingerprint,
  startedAt: Date.now(),
});
mkdirSync(dirname(lockfile), { recursive: true });
let ownsLock = false;
for (let attempt = 0; attempt < 20 && !ownsLock; attempt++) {
  try {
    writeFileSync(lockfile, ownership, { flag: "wx" });
    ownsLock = true;
  } catch {
    if (await equivalentServerAlive()) break;
    try { rmSync(lockfile, { force: true }); } catch { /* another contender recovered it */ }
    await Bun.sleep(10 + Math.floor(Math.random() * 20));
  }
}
if (!ownsLock) {
  server.stop(true);
  process.exit(0);
}

const cleanup = (): void => {
  try {
    const current = JSON.parse(readFileSync(lockfile, "utf8")) as { pid?: number };
    if (current.pid === process.pid) rmSync(lockfile, { force: true });
  } catch { /* absent or not ours */ }
};
process.on("exit", cleanup);
process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));

try { rmSync(startfile, { force: true }); } catch { /* absent */ }
resetIdle();
if (process.env.CAIRN_ENGINE_SKIP_WARMUP !== "1") {
  void warmSearchEngine().catch((error) => {
    console.error(`[cairn] engine warmup failed: ${error instanceof Error ? error.message : String(error)}`);
  });
}
