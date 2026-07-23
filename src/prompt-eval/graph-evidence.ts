import type { PromptHost } from "./types";

export interface ToolEvent {
  args: Record<string, unknown>;
  result: unknown;
  name: string;
  host: PromptHost;
}

export const normalizeToolName = (value: string): string =>
  value.toLowerCase().replace(/^.*(?:__|-)(?=(?:brain|skill)_)/, "");

function structured(value: unknown): unknown {
  if (typeof value === "string") {
    try { return structured(JSON.parse(value)); } catch { return value; }
  }
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(structured);
  const row = value as Record<string, unknown>;
  if (typeof row.id === "string") return row;
  for (const key of ["textResultForLlm", "toolResult", "result"]) {
    if (row[key] != null) return structured(row[key]);
  }
  if (Array.isArray(row.content)) {
    return structured(row.content.length === 1 ? row.content[0] : row.content);
  }
  if (typeof row.text === "string") return structured(row.text);
  return row;
}

export function resultIds(value: unknown): string[] {
  const parsed = structured(value);
  if (Array.isArray(parsed)) return parsed.flatMap(resultIds);
  if (!parsed || typeof parsed !== "object") return [];
  const id = (parsed as Record<string, unknown>).id;
  return typeof id === "string" && id ? [id] : [];
}

export function graphEvidence(events: ToolEvent[]) {
  const created: string[] = [];
  const depths = new Map<string, number>();
  const answered = new Set<string>();
  const cited = new Set<string>();
  const returned = new Set<string>();
  const used = new Set<string>();
  let searchedAt = -1;
  let firstWriteAt = -1;
  let lastAnswerId = "";
  for (const [index, event] of events.entries()) {
    if (event.name === "brain_search") {
      if (searchedAt < 0) searchedAt = index;
      for (const id of resultIds(event.result)) returned.add(id);
    }
    if (event.name === "brain_create") {
      if (firstWriteAt < 0) firstWriteAt = index;
      const id = resultIds(event.result)[0];
      if (!id) continue;
      created.push(id);
      const edges = Array.isArray(event.args.edges) ? event.args.edges as string[] : [];
      for (const edge of edges) used.add(edge);
      const parentDepths = edges.map((edge) => depths.get(edge))
        .filter((value): value is number => value != null);
      depths.set(id, parentDepths.length ? Math.max(...parentDepths) + 1 : 0);
    }
    if (event.name === "brain_mutate") {
      if (firstWriteAt < 0) firstWriteAt = index;
      const id = String(event.args.id || "");
      if (id) used.add(id);
      if (id && typeof event.args.answer === "string" && event.args.answer.trim()) {
        answered.add(id);
        lastAnswerId = id;
      }
      if (id && typeof event.args.citation === "string" && event.args.citation.trim()) {
        cited.add(id);
      }
    }
  }
  const root = created[0] || "";
  return {
    root,
    createdNodes: created.length,
    answeredNodes: created.filter((id) => answered.has(id)).length,
    citedAnswers: created.filter((id) => cited.has(id)).length,
    deepestLevel: Math.max(0, ...depths.values()),
    returnedNodes: returned.size,
    usedReturnedNodes: [...returned].filter((id) => used.has(id)).length,
    rootSynthesized: Boolean(root && answered.has(root)),
    rootSynthesizedLast: Boolean(root && lastAnswerId === root),
    searchBeforeWrite: searchedAt >= 0 && (firstWriteAt < 0 || searchedAt < firstWriteAt),
  };
}
