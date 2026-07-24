export interface RuntimeIdentity {
  version: string;
  releaseFingerprint: string;
  pid?: number;
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
