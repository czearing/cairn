export function skillResultId(value: unknown): string {
  if (typeof value === "string") {
    try { return skillResultId(JSON.parse(value)); } catch { return ""; }
  }
  if (!value || typeof value !== "object") return "";
  if (Array.isArray(value)) {
    for (const item of value) {
      const id = skillResultId(item);
      if (id) return id;
    }
    return "";
  }

  const record = value as Record<string, unknown>;
  if (typeof record.id === "string") return record.id.trim();
  for (const key of ["textResultForLlm", "text", "content", "result", "toolResult"]) {
    const id = skillResultId(record[key]);
    if (id) return id;
  }
  return "";
}

export function skillResultIds(value: unknown): string[] {
  if (typeof value === "string") {
    try { return skillResultIds(JSON.parse(value)); } catch { return []; }
  }
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value)) return [...new Set(value.flatMap(skillResultIds))];
  const record = value as Record<string, unknown>;
  const direct = typeof record.id === "string" ? [record.id.trim()].filter(Boolean) : [];
  const selected = Array.isArray(record.selected) ? record.selected.flatMap(skillResultIds) : [];
  const nested = ["textResultForLlm", "text", "content", "result", "toolResult"]
    .flatMap((key) => skillResultIds(record[key]));
  return [...new Set([...direct, ...selected, ...nested])];
}
