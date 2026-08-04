import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { config, searchOptionsFromConfig } from "./config";
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
  type EngineTelemetryIdentity,
} from "./engine-protocol";
import type { Neuron, NeuronPatch } from "./neurons.types";
import type { DuplicateCandidate } from "./neurons";
import type { ScoredResult } from "./search.types";
import { jsonChars } from "./telemetry-size";
import { recordTelemetry } from "./telemetry-record";
import { writerEnv } from "./writer-role";

const identity = (): EngineIdentity => ({
  dbPath: config.dbPath,
  model: embedModel(),
});
const searchOptions = searchOptionsFromConfig;
const fingerprint = (): string => engineFingerprint(identity());
const lockfile = (): string => engineLockfile(fingerprint());
const startfile = (): string => engineStartfile(fingerprint());
const eligible = (): boolean =>
  process.env.CAIRN_ENGINE_NO_SERVER !== "1"
  && (!config.dbPath.startsWith(tmpdir()) || process.env.CAIRN_ENGINE_ALLOW_TEMP === "1");

function lock(): ReturnType<typeof parseEngineLock> {
  try { return parseEngineLock(readFileSync(lockfile(), "utf8"), fingerprint()); }
  catch { return null; }
}

async function health(candidate: NonNullable<ReturnType<typeof lock>>): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${candidate.port}/v1/health`, {
      headers: { authorization: `Bearer ${candidate.token}` },
      signal: AbortSignal.timeout(1000),
    });
    if (!response.ok) return false;
    const body = await response.json() as { protocol?: number; fingerprint?: string };
    return body.protocol === ENGINE_PROTOCOL_VERSION && body.fingerprint === fingerprint();
  } catch {
    return false;
  }
}

function claimStartup(): boolean {
  const path = startfile();
  try { mkdirSync(dirname(path), { recursive: true }); } catch { /* exists */ }
  try {
    writeFileSync(path, JSON.stringify({
      pid: process.pid,
      startedAt: Date.now(),
      fingerprint: fingerprint(),
    }), { flag: "wx" });
    return true;
  } catch {
    try {
      const staleMs = Number(process.env.CAIRN_ENGINE_STARTUP_STALE_MS || "120000");
      if (startupClaimActive(path, staleMs)) return false;
      rmSync(path, { force: true });
      writeFileSync(path, JSON.stringify({
        pid: process.pid,
        startedAt: Date.now(),
        fingerprint: fingerprint(),
      }), { flag: "wx" });
      return true;
    } catch {
      return false;
    }
  }
}

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as { code?: string })?.code === "EPERM"; }
}

export function startupClaimActive(path: string, staleMs: number): boolean {
  try {
    const claim = JSON.parse(readFileSync(path, "utf8")) as { pid?: unknown };
    const pid = Number(claim.pid);
    if (Number.isSafeInteger(pid) && pid > 0 && !pidAlive(pid)) return false;
    return Date.now() - statSync(path).mtimeMs <= staleMs;
  } catch {
    return false;
  }
}

let spawned = false;
function ensureServer(): void {
  if (!eligible() || spawned || !claimStartup()) return;
  spawned = true;
  try {
    const bin = process.platform === "win32" ? "bun.exe" : "bun";
    const path = process.env.CAIRN_ENGINE_SERVER
      || fileURLToPath(new URL("./engine-server.ts", import.meta.url));
    spawn(bin, [path], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: writerEnv(),
    }).unref();
  } catch {
    spawned = false;
    try { rmSync(startfile(), { force: true }); } catch { /* absent */ }
  }
}

async function readyServer(
  wait: boolean,
  waitMs = Number(process.env.CAIRN_ENGINE_STARTUP_WAIT_MS || "3000"),
): Promise<NonNullable<ReturnType<typeof lock>> | null> {
  if (!eligible()) return null;
  const current = lock();
  if (current && await health(current)) return current;
  spawned = false;
  ensureServer();
  if (!wait) return null;
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    await Bun.sleep(100);
    const candidate = lock();
    if (candidate && await health(candidate)) return candidate;
  }
  return null;
}

export async function warmEngineServer(): Promise<boolean> {
  return Boolean(await readyServer(true));
}

async function execute(
  request: EngineRequest,
  telemetry?: EngineTelemetryIdentity,
): Promise<EngineResponse | null> {
  const started = performance.now();
  let candidate = await readyServer(true);
  if (!candidate && request.operation === "search") {
    candidate = await readyServer(
      true,
      Number(process.env.CAIRN_ENGINE_COLD_SEARCH_RETRY_MS || "5000"),
    );
  }
  if (!candidate) {
    recordTelemetry({
      kind: "engine_transport",
      source: "fallback",
      toolName: request.operation,
      inputChars: jsonChars(request.payload),
      durationMs: performance.now() - started,
      success: false,
      ...telemetry,
    });
    return null;
  }
  const attempt = async (): Promise<EngineResponse | null> => {
    try {
      const response = await fetch(`http://127.0.0.1:${candidate.port}/v1/execute`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${candidate.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(Number(process.env.CAIRN_ENGINE_REQUEST_TIMEOUT_MS || "2000")),
      });
      if (!response.ok) return null;
      return await response.json() as EngineResponse;
    } catch {
      return null;
    }
  };
  const first = await attempt();
  const response = first ?? (request.operation === "search" ? null : await attempt());
  recordTelemetry({
    kind: "engine_transport",
    source: response ? "daemon" : "fallback",
    toolName: request.operation,
    inputChars: jsonChars(request.payload),
    outputChars: response ? jsonChars(response) : 0,
    durationMs: performance.now() - started,
    // Transport health is delivery, not the verdict inside the payload: an engine
    // that answers "rejected" is a working transport, so counting it as a failure
    // would bury real outages (which surface as the `fallback` source).
    success: response !== null,
    ...telemetry,
  });
  return response;
}

const resultOrThrow = <T>(response: EngineResponse): T => {
  if (!response.ok) throw new Error(response.error);
  return response.result as T;
};

export async function engineSearch(
  query: string,
  telemetry?: EngineTelemetryIdentity,
): Promise<ScoredResult[]> {
  const response = await execute({
    requestId: randomUUID(),
    operation: "search",
    payload: { query, options: searchOptions() },
    telemetry,
  }, telemetry);
  if (response) {
    const remote = resultOrThrow<ScoredResult[]>(response);
    if (process.env.CAIRN_ENGINE_SHADOW === "1") {
      const { search } = await import("./search");
      const local = await search(query, null, searchOptions());
      const digest = (value: ScoredResult[]): string =>
        createHash("sha256").update(JSON.stringify(value)).digest("hex");
      const match = digest(remote) === digest(local);
      recordTelemetry({
        kind: "engine_parity",
        source: match ? "match" : "mismatch",
        toolName: "search",
        itemCount: remote.length,
        success: match,
        ...telemetry,
      });
    }
    return remote;
  }
  const { search } = await import("./search");
  return search(query, telemetry ?? null, searchOptions());
}

export async function engineCreate(
  text: string,
  edges: string[] = [],
  telemetry?: EngineTelemetryIdentity,
  requestedId?: string,
): Promise<{ neuron: Neuron; nearDuplicates: DuplicateCandidate[] }> {
  const id = requestedId ?? randomUUID();
  const response = await execute({
    requestId: randomUUID(),
    operation: "create",
    payload: { id, text, edges },
  }, telemetry);
  if (response) {
    return resultOrThrow<{ neuron: Neuron; nearDuplicates: DuplicateCandidate[] }>(response);
  }
  const { createWithDuplicateCandidates } = await import("./neurons");
  return createWithDuplicateCandidates(text, edges, id);
}

export async function engineMutate(
  id: string,
  patch: NeuronPatch,
  telemetry?: EngineTelemetryIdentity,
): Promise<Neuron | null> {
  const response = await execute({
    requestId: randomUUID(),
    operation: "mutate",
    payload: { id, patch },
  }, telemetry);
  if (response) return resultOrThrow<Neuron | null>(response);
  const { mutate } = await import("./neurons");
  return mutate(id, patch);
}

export async function engineDelete(
  id: string,
  telemetry?: EngineTelemetryIdentity,
): Promise<boolean> {
  const response = await execute({
    requestId: randomUUID(),
    operation: "delete",
    payload: { id },
  }, telemetry);
  if (response) return resultOrThrow<boolean>(response);
  const { remove } = await import("./neurons");
  return remove(id);
}

export async function engineLink(a: string, b: string): Promise<boolean> {
  const response = await execute({
    requestId: randomUUID(),
    operation: "link",
    payload: { a, b },
  });
  if (response) return resultOrThrow<boolean>(response);
  const { link } = await import("./neurons");
  link(a, b);
  return true;
}

export async function engineUnlink(a: string, b: string): Promise<boolean> {
  const response = await execute({
    requestId: randomUUID(),
    operation: "unlink",
    payload: { a, b },
  });
  if (response) return resultOrThrow<boolean>(response);
  const { unlink } = await import("./neurons");
  unlink(a, b);
  return true;
}
