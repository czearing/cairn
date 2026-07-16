import { db } from "./db";

export interface EdgeRow {
  sourceId: string;
  targetId: string;
  relationType: string;
  provenance: string;
  position: number;
}

const edgeSelect = `SELECT
  source_id AS sourceId,
  target_id AS targetId,
  relation_type AS relationType,
  provenance,
  position
  FROM neuron_edges`;

export function edgesFrom(sourceId: string, relationType = "related"): string[] {
  return (db().query(`${edgeSelect}
    WHERE source_id = ? AND relation_type = ?
    ORDER BY position, target_id`).all(sourceId, relationType) as EdgeRow[])
    .map((edge) => edge.targetId);
}

export function edgesForSources(ids: string[], relationType = "related"): Map<string, string[]> {
  const unique = [...new Set(ids)].filter(Boolean);
  const result = new Map<string, string[]>(unique.map((id) => [id, []]));
  if (!unique.length) return result;
  for (let start = 0; start < unique.length; start += 500) {
    const chunk = unique.slice(start, start + 500);
    const rows = db().query(`${edgeSelect}
      WHERE relation_type = ? AND source_id IN (${chunk.map(() => "?").join(",")})
      ORDER BY source_id, position, target_id`).all(relationType, ...chunk) as EdgeRow[];
    for (const row of rows) result.get(row.sourceId)?.push(row.targetId);
  }
  return result;
}

function syncLegacy(sourceId: string): void {
  db().query("UPDATE neurons SET edges = ? WHERE id = ?")
    .run(JSON.stringify(edgesFrom(sourceId)), sourceId);
}

export function replaceEdges(
  sourceId: string,
  targets: string[],
  provenance = "agent",
  relationType = "related"
): void {
  const clean = [...new Set(targets)].filter((target) => target && target !== sourceId);
  db().query("DELETE FROM neuron_edges WHERE source_id = ? AND relation_type = ?")
    .run(sourceId, relationType);
  const insert = db().query(`INSERT INTO neuron_edges(
    source_id,target_id,relation_type,provenance,position
  ) VALUES (?,?,?,?,?)`);
  clean.forEach((target, position) =>
    insert.run(sourceId, target, relationType, provenance, position)
  );
  syncLegacy(sourceId);
}

export function addEdge(
  sourceId: string,
  targetId: string,
  provenance = "agent",
  relationType = "related"
): void {
  if (!sourceId || !targetId || sourceId === targetId) return;
  const position = (db().query(`SELECT COALESCE(MAX(position), -1) + 1 AS position
    FROM neuron_edges WHERE source_id = ? AND relation_type = ?`)
    .get(sourceId, relationType) as { position: number }).position;
  db().query(`INSERT INTO neuron_edges(
    source_id,target_id,relation_type,provenance,position
  ) VALUES (?,?,?,?,?) ON CONFLICT(source_id,target_id,relation_type) DO NOTHING`)
    .run(sourceId, targetId, relationType, provenance, position);
  syncLegacy(sourceId);
}

export function removeEdge(sourceId: string, targetId: string, relationType = "related"): void {
  db().query("DELETE FROM neuron_edges WHERE source_id = ? AND target_id = ? AND relation_type = ?")
    .run(sourceId, targetId, relationType);
  syncLegacy(sourceId);
}

export function linkBoth(a: string, b: string, provenance = "agent"): void {
  db().transaction(() => {
    addEdge(a, b, provenance);
    addEdge(b, a, provenance);
  });
}

export function unlinkBoth(a: string, b: string): void {
  db().transaction(() => {
    removeEdge(a, b);
    removeEdge(b, a);
  });
}

export function sourcesTargeting(targetId: string): string[] {
  return (db().query(`SELECT source_id AS sourceId
    FROM neuron_edges WHERE target_id = ? ORDER BY source_id`)
    .all(targetId) as { sourceId: string }[]).map((row) => row.sourceId);
}

export function resyncLegacyEdges(ids: string[]): void {
  for (const id of [...new Set(ids)].filter(Boolean)) syncLegacy(id);
}
