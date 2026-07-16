import { Database } from "bun:sqlite";
import * as sqliteVec from "sqlite-vec";
import { config } from "./config";
import { encodeVector } from "./vector";

interface VecRow {
  id: string;
  distance: number;
}

export interface IndexedScore {
  id: string;
  score: number;
}

export function exactVectorCandidates(
  query: number[],
  model: string,
  absoluteFloor: number,
  relativeFloor: number,
  threshold: number,
  initial = 256
): IndexedScore[] | null {
  if (threshold <= 0) return null;
  const database = new Database(config.dbPath, { readonly: true });
  try {
    const counts = database.query("SELECT COUNT(*) AS total FROM neurons").get() as { total: number };
    if (counts.total < threshold) return null;
    sqliteVec.load(database);
    const state = database.query(`SELECT
      model,
      dimensions,
      table_name AS tableName,
      source_seq AS sourceSeq
      FROM neuron_vector_index WHERE singleton = 1`).get() as {
        model: string;
        dimensions: number;
        tableName: string;
        sourceSeq: number;
      } | null;
    const seq = (database.query("SELECT value FROM engine_meta WHERE key = 'vector_seq'")
      .get() as { value: number }).value;
    if (
      !state
      || state.model !== model
      || state.dimensions !== query.length
      || state.sourceSeq !== seq
      || !/^neuron_vec_\d+_[a-f0-9]{12}$/.test(state.tableName)
    ) return null;
    const indexed = (database.query(`SELECT COUNT(*) AS count FROM "${state.tableName}"`)
      .get() as { count: number }).count;
    if (indexed !== counts.total) return null;
    const vector = encodeVector(query);
    let limit = Math.min(counts.total, Math.max(1, initial));
    const statement = database.query(`SELECT id,distance FROM "${state.tableName}"
      WHERE embedding MATCH ? AND k = ? ORDER BY distance`);
    while (true) {
      const rows = statement.all(vector, limit) as VecRow[];
      if (!rows.length) return [];
      const topSimilarity = 1 - rows[0]!.distance;
      const floor = relativeFloor > 0
        ? Math.max(absoluteFloor, topSimilarity * relativeFloor)
        : absoluteFloor;
      const epsilon = 1e-6;
      const lastSimilarity = 1 - rows[rows.length - 1]!.distance;
      if (limit >= counts.total || lastSimilarity < floor - epsilon) {
        return rows
          .map((row) => ({ id: row.id, score: 1 - row.distance }))
          .filter((row) => row.score >= floor - epsilon);
      }
      limit = Math.min(counts.total, limit * 2);
    }
  } catch {
    return null;
  } finally {
    database.close();
  }
}
