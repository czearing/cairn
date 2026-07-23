export function structuredResult(value: unknown): unknown {
  if (typeof value === "string") {
    try { return structuredResult(JSON.parse(value)); } catch { return value; }
  }
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(structuredResult);
  const record = value as Record<string, unknown>;
  if (typeof record.id === "string") return record;
  for (const key of ["textResultForLlm", "toolResult", "result"]) {
    if (record[key] != null) return structuredResult(record[key]);
  }
  if (typeof record.text === "string") return structuredResult(record.text);
  if (Array.isArray(record.content)) {
    return structuredResult(record.content.length === 1 ? record.content[0] : record.content);
  }
  return record;
}

export function resultIds(value: unknown): string[] {
  const parsed = structuredResult(value);
  if (Array.isArray(parsed)) return parsed.flatMap(resultIds);
  if (!parsed || typeof parsed !== "object") return [];
  const id = (parsed as Record<string, unknown>).id;
  return typeof id === "string" && id.trim() ? [id.trim()] : [];
}

export function telemetryResultSucceeded(result: unknown): boolean {
  if (!result || typeof result !== "object") return true;
  const value = result as { success?: unknown; isError?: unknown; resultType?: unknown };
  return value.success !== false && value.isError !== true
    && (value.resultType == null || value.resultType === "success");
}
