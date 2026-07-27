import { createHash } from "node:crypto";
import { db } from "./db";

interface IndexMeta {
  model: string;
  dimensions: number;
  tableName: string;
  sourceSeq: number;
}

const safeTableName = (model: string, dimensions: number): string =>
  `neuron_vec_${dimensions}_${createHash("sha256").update(model).digest("hex").slice(0, 12)}`;

const currentSeq = (): number =>
  (db().query("SELECT value FROM engine_meta WHERE key = 'vector_seq'").get() as { value: number }).value;

function meta(): IndexMeta | null {
  const row = db().query(`SELECT
    model,
    dimensions,
    table_name AS tableName,
    source_seq AS sourceSeq
    FROM neuron_vector_index WHERE singleton = 1`).get() as IndexMeta | null;
  return row ?? null;
}

function createTable(tableName: string, dimensions: number): void {
  db().run(`CREATE VIRTUAL TABLE IF NOT EXISTS "${tableName}" USING vec0(
    id TEXT PRIMARY KEY,
    embedding float[${dimensions}] distance_metric=cosine
  )`);
}

function rebuild(model: string, dimensions: number, tableName: string): void {
  createTable(tableName, dimensions);
  const insert = db().query(`INSERT OR REPLACE INTO "${tableName}"(id,embedding) VALUES (?,?)`);
  db().transaction(() => {
    db().run(`DELETE FROM "${tableName}"`);
    const rows = db().query(`SELECT id,embedding FROM neurons
      WHERE embedding_model = ? AND length(embedding) = ? ORDER BY rowid`)
      .all(model, dimensions * 4) as { id: string; embedding: Uint8Array }[];
    for (const row of rows) insert.run(row.id, row.embedding);
    db().query(`INSERT INTO neuron_vector_index(
      singleton,model,dimensions,table_name,source_seq
    ) VALUES (1,?,?,?,?)
    ON CONFLICT(singleton) DO UPDATE SET
      model=excluded.model,
      dimensions=excluded.dimensions,
      table_name=excluded.table_name,
      source_seq=excluded.source_seq`)
      .run(model, dimensions, tableName, currentSeq());
  });
}

function hasCompleteCompatibleCoverage(
  model: string,
  dimensions: number,
  tableName: string,
): boolean {
  try {
    const compatible = (db().query(`SELECT COUNT(*) AS count FROM neurons
      WHERE embedding_model = ? AND length(embedding) = ?`)
      .get(model, dimensions * 4) as { count: number }).count;
    const indexed = (db().query(`SELECT COUNT(*) AS count FROM "${tableName}"`)
      .get() as { count: number }).count;
    return indexed === compatible;
  } catch {
    return false;
  }
}

export function prepareVectorIndex(model: string, dimensions: number): string {
  const tableName = safeTableName(model, dimensions);
  const existing = meta();
  const sourceSeq = currentSeq();
  if (
    !existing
    || existing.model !== model
    || existing.dimensions !== dimensions
    || existing.tableName !== tableName
    || existing.sourceSeq !== sourceSeq
  ) rebuild(model, dimensions, tableName);
  return tableName;
}

export function repairVectorIndexCoverage(model: string, dimensions: number): boolean {
  const tableName = prepareVectorIndex(model, dimensions);
  if (hasCompleteCompatibleCoverage(model, dimensions, tableName)) return false;
  rebuild(model, dimensions, tableName);
  return true;
}

export function prepareCurrentVectorIndex(): IndexMeta | null {
  const existing = meta();
  if (!existing) return null;
  prepareVectorIndex(existing.model, existing.dimensions);
  return meta();
}

export function writeNeuronVector(id: string, model: string, embedding: Uint8Array): void {
  const dimensions = embedding.byteLength / 4;
  const existing = meta();
  const tableName = existing?.model === model && existing.dimensions === dimensions
    ? existing.tableName
    : prepareVectorIndex(model, dimensions);
  db().query(`DELETE FROM "${tableName}" WHERE id = ?`).run(id);
  db().query(`INSERT INTO "${tableName}"(id,embedding) VALUES (?,?)`).run(id, embedding);
  db().query("UPDATE neuron_vector_index SET source_seq = ? WHERE singleton = 1")
    .run(currentSeq());
}

export function deleteNeuronVector(id: string): void {
  const existing = meta();
  if (!existing) return;
  createTable(existing.tableName, existing.dimensions);
  db().query(`DELETE FROM "${existing.tableName}" WHERE id = ?`).run(id);
  db().query("UPDATE neuron_vector_index SET source_seq = ? WHERE singleton = 1")
    .run(currentSeq());
}

export function activeVectorIndex(): IndexMeta | null {
  return meta();
}
