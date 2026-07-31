import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { sourceRevisionAvailable } from "./release";

const hookPath = (): string =>
  process.env.CAIRN_COPILOT_HOOK_PATH || join(homedir(), ".copilot", "hooks", "cairn.json");

/**
 * Pure policy: the hook file's cairnRelease is written at install time, so a source checkout that
 * commits between installs keeps stamping telemetry with an old release. That fragments attribution
 * and makes hook and runtime releases disagree mid-session. Restamp only when a live source revision
 * proves the label is stale — never when the release was not derived from a checkout.
 */
export function releaseLabelRestamp(installed: string, live: string): string | null {
  if (!sourceRevisionAvailable || !live || installed === live) return null;
  return live;
}

export interface RuntimeIdentity {
  version: string;
  releaseFingerprint: string;
  pid?: number;
}

export function installedReleaseVersion(fallback: string): string {
  if (process.env.CAIRN_RELEASE) return process.env.CAIRN_RELEASE;
  try {
    const hook = JSON.parse(readFileSync(hookPath(), "utf8")) as { cairnRelease?: unknown };
    if (typeof hook.cairnRelease === "string" && hook.cairnRelease.trim()) {
      return hook.cairnRelease.trim();
    }
  } catch { /* source checkouts and non-Copilot hosts use the imported fallback */ }
  return fallback;
}

/**
 * Effect: apply releaseLabelRestamp to the hook file, rewriting only the cairnRelease field so the
 * hook file stays authoritative for hot reload while never drifting behind the checkout. Silent on
 * any failure — a stale label must never break a turn.
 */
export function healReleaseLabel(live: string): boolean {
  try {
    const path = hookPath();
    const raw = readFileSync(path, "utf8");
    const hook = JSON.parse(raw) as { cairnRelease?: unknown };
    const installed = typeof hook.cairnRelease === "string" ? hook.cairnRelease.trim() : "";
    const next = releaseLabelRestamp(installed, live);
    if (!next) return false;
    writeFileSync(path, `${JSON.stringify({ ...hook, cairnRelease: next }, null, 2)}\n`, "utf8");
    return true;
  } catch {
    return false;
  }
}

const identity = (value: unknown): RuntimeIdentity | null => {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const version = typeof record.version === "string" ? record.version : "";
  const releaseFingerprint = typeof record.releaseFingerprint === "string"
    ? record.releaseFingerprint
    : "";
  if (!version || !releaseFingerprint) return null;
  const pid = Number(record.pid);
  return {
    version,
    releaseFingerprint,
    ...(Number.isSafeInteger(pid) && pid > 0 ? { pid } : {}),
  };
};

export const runtimeMetadata = (runtime: RuntimeIdentity) => ({
  cairn: {
    version: runtime.version,
    releaseFingerprint: runtime.releaseFingerprint,
    pid: runtime.pid ?? process.pid,
  },
});

export function runtimeIdentityFromResult(value: unknown): RuntimeIdentity | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const direct = identity((record._meta as Record<string, unknown> | undefined)?.cairn);
  if (direct) return direct;
  for (const key of ["toolResult", "tool_result", "result"]) {
    const nested = runtimeIdentityFromResult(record[key]);
    if (nested) return nested;
  }
  return null;
}
