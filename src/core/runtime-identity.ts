import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface RuntimeIdentity {
  version: string;
  releaseFingerprint: string;
  pid?: number;
}

export function installedReleaseVersion(fallback: string): string {
  if (process.env.CAIRN_RELEASE) return process.env.CAIRN_RELEASE;
  try {
    const hook = JSON.parse(readFileSync(
      process.env.CAIRN_COPILOT_HOOK_PATH || join(homedir(), ".copilot", "hooks", "cairn.json"),
      "utf8",
    )) as { cairnRelease?: unknown };
    if (typeof hook.cairnRelease === "string" && hook.cairnRelease.trim()) {
      return hook.cairnRelease.trim();
    }
  } catch { /* source checkouts and non-Copilot hosts use the imported fallback */ }
  return fallback;
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
