import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { Neuron, NeuronPatch } from "./neurons.types";
import type { DuplicateCandidate } from "./neurons";
import type { ScoredResult } from "./search.types";
import type { SearchOptions } from "./search.types";
import type { TelemetryEvent } from "./telemetry-record-types";

export const ENGINE_PROTOCOL_VERSION = 1;
export const engineLockfile = (fingerprint: string): string =>
  process.env.CAIRN_ENGINE_LOCKFILE
  || join(homedir(), ".cairn", `engine-server-${fingerprint}.json`);
export const engineStartfile = (fingerprint: string): string =>
  process.env.CAIRN_ENGINE_STARTFILE
  || join(homedir(), ".cairn", `engine-server-${fingerprint}-starting.json`);

export type EngineTelemetryIdentity = Pick<
  TelemetryEvent,
  "releaseFingerprint" | "version" | "runClass"
>;

export interface EngineIdentity {
  dbPath: string;
  model: string;
}

export interface EngineLock {
  protocol: number;
  port: number;
  pid: number;
  token: string;
  fingerprint: string;
  startedAt: number;
}

export type EngineRequest =
  | {
      requestId: string;
      operation: "search";
      payload: { query: string; options: SearchOptions };
      telemetry?: EngineTelemetryIdentity;
    }
  | {
      requestId: string;
      operation: "create";
      payload: { id: string; text: string; edges: string[] };
    }
  | {
      requestId: string;
      operation: "mutate";
      payload: { id: string; patch: NeuronPatch };
    }
  | {
      requestId: string;
      operation: "delete";
      payload: { id: string };
    }
  | {
      requestId: string;
      operation: "link" | "unlink";
      payload: { a: string; b: string };
    };

type EngineResult =
  | ScoredResult[]
  | { neuron: Neuron; nearDuplicates: DuplicateCandidate[] }
  | Neuron
  | null
  | boolean;

export type EngineResponse =
  | { ok: true; result: EngineResult }
  | { ok: false; error: string };

export function engineFingerprint(identity: EngineIdentity): string {
  return createHash("sha256").update(JSON.stringify({
    ...identity,
    dbPath: resolve(identity.dbPath).toLowerCase(),
  })).digest("hex").slice(0, 24);
}

export function parseEngineLock(value: string, fingerprint: string): EngineLock | null {
  try {
    const lock = JSON.parse(value) as Partial<EngineLock>;
    if (
      lock.protocol !== ENGINE_PROTOCOL_VERSION
      || !Number.isSafeInteger(lock.port)
      || Number(lock.port) <= 0
      || !Number.isSafeInteger(lock.pid)
      || Number(lock.pid) <= 0
      || typeof lock.token !== "string"
      || lock.token.length < 32
      || lock.fingerprint !== fingerprint
    ) return null;
    return lock as EngineLock;
  } catch {
    return null;
  }
}
