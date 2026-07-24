export interface ToolEntityObservation {
  kind: string;
  entityType: "brain" | "skill";
  entityId: string;
  rank?: number;
  scoreBucket?: number;
}

const strings = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && Boolean(item))
    : [];

const observations = (
  kind: string,
  entityType: ToolEntityObservation["entityType"],
  ids: string[],
): ToolEntityObservation[] =>
  [...new Set(ids.filter(Boolean))].map((entityId) => ({ kind, entityType, entityId }));

export function toolEntityObservations(
  tool: string,
  args: Record<string, unknown>,
  parsed: unknown,
  ids: string[],
): ToolEntityObservation[] {
  const result: ToolEntityObservation[] = [];
  if (tool === "skill_select") result.push(...observations("skill_selected", "skill", strings(args.ids)));
  if (tool === "skill_create") result.push(...observations("skill_created", "skill", ids));
  if (tool === "skill_edit") result.push(...observations("skill_edited", "skill", [String(args.id || "")]));
  if (tool === "brain_search" && Array.isArray(parsed)) {
    parsed.forEach((item, index) => {
      if (!item || typeof item !== "object") return;
      const row = item as Record<string, unknown>;
      const entityId = typeof row.id === "string" ? row.id : "";
      const score = Number(row.score);
      if (entityId) result.push({
        kind: "brain_returned",
        entityType: "brain",
        entityId,
        rank: index + 1,
        scoreBucket: Number.isFinite(score)
          ? Math.max(0, Math.min(20, Math.round(score * 20)))
          : 0,
      });
    });
  } else if (tool === "brain_search") {
    result.push(...observations("brain_returned", "brain", ids));
  }
  if (tool === "brain_create") result.push(...observations("brain_created", "brain", ids));
  if (tool === "brain_mutate") result.push(...observations("brain_mutated", "brain", [String(args.id || "")]));
  if (tool === "brain_delete") result.push(...observations("brain_deleted", "brain", [String(args.id || "")]));
  if (tool === "brain_create" || tool === "brain_mutate") {
    result.push(...observations("brain_referenced", "brain", strings(args.edges)));
  }
  return result;
}
