interface ToolEntityObservation {
  kind: string;
  entityType: "brain" | "skill";
  entityId: string;
  rank?: number;
  scoreBucket?: number;
  itemCount?: number;
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
  if (tool === "skill_select") {
    const selected = strings(args.ids).filter((id) => id.trim().toLowerCase() !== "none");
    const row = parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
    const catalogSize = Number.isFinite(Number(row.catalogSize)) ? Number(row.catalogSize) : 0;
    // One outcome row per call, emitted whether or not anything was selected. Without it an empty
    // selection writes no row at all, so stored telemetry cannot tell a delivered-but-unmatched
    // catalog from a catalog that never arrived. The reason code is the entity so it can be grouped.
    const reason = typeof row.reason === "string" && row.reason
      ? row.reason
      : (row.error ? "selection_error" : "selected");
    result.push({
      kind: "skill_selection",
      entityType: "skill",
      entityId: reason,
      itemCount: catalogSize,
    });
    result.push(...observations("skill_selected", "skill", selected)
      .map((observation, index) => ({ ...observation, rank: index + 1, itemCount: catalogSize })));
  }
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
