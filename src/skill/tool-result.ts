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
