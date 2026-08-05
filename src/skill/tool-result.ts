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

function skillResultNoMatch(value: unknown): boolean {
  if (typeof value === "string") {
    try { return skillResultNoMatch(JSON.parse(value)); } catch { return false; }
  }
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(skillResultNoMatch);
  const record = value as Record<string, unknown>;
  if (record.noMatch === true) return true;
  return ["textResultForLlm", "text", "content", "result", "toolResult"]
    .some((key) => skillResultNoMatch(record[key]));
}

/** Resolve what a `skill_select` call actually selected, from its arguments and its tool result.
 *
 *  Both hosts must agree on this or one of them will raise a review obligation the other never clears,
 *  so the rule lives here once: an explicit `["none"]` (or a `noMatch` result) selects nothing, otherwise
 *  prefer the durable ids the tool echoed back, and fall back to the titles/ids the agent asked for when a
 *  host truncates or reshapes the result payload. */
export function selectedSkillIds(
  requestedIds: unknown,
  result: unknown
): { ids: string[]; noMatch: boolean } {
  const requested = Array.isArray(requestedIds)
    ? requestedIds.filter((id): id is string => typeof id === "string" && id.trim().length > 0)
    : [];
  const noMatch = skillResultNoMatch(result)
    || (requested.length === 1 && requested[0]!.toLowerCase() === "none");
  if (noMatch) return { ids: [], noMatch: true };
  const resolved = skillResultIds(result);
  return { ids: resolved.length ? resolved : requested, noMatch: false };
}
