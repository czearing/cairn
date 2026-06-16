// One-time import of an existing local brain into a Turso cloud primary, so every device's libSQL
// embedded replica starts from it. Idempotent (INSERT OR REPLACE) — safe to re-run.
//
//   CAIRN_LIBSQL_URL=... CAIRN_LIBSQL_TOKEN=... bun scripts/migrate-to-turso.ts
//
// Reads the source read-only; the source brain is never modified. Creds come from env only.
import { Database as Bun } from "bun:sqlite";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";

const url = process.env.CAIRN_LIBSQL_URL;
const token = process.env.CAIRN_LIBSQL_TOKEN;
if (!url || !token) throw new Error("set CAIRN_LIBSQL_URL and CAIRN_LIBSQL_TOKEN");

const source = process.env.CAIRN_MIGRATE_SOURCE || join(homedir(), ".cairn", "cairn.db");
const replica = process.env.CAIRN_LIBSQL_LOCAL || join(homedir(), ".cairn", "cairn-replica.db");
console.log("source :", source);
console.log("replica:", replica);

// --- read every row from the local brain (read-only) ---
interface SrcRow {
  id: string; text: string; answer: string; citation: string;
  edges: string; embedding: string | null; embedding_model: string | null;
}
const src = new Bun(source, { readonly: true });
const rows = src.query(
  "SELECT id, text, answer, citation, edges, embedding, embedding_model FROM neurons ORDER BY rowid"
).all() as SrcRow[];
console.log("source rows:", rows.length);

// --- open the Turso cloud primary as an embedded replica ---
const requireCjs = createRequire(import.meta.url);
const Libsql = requireCjs("libsql") as new (path: string, opts: Record<string, unknown>) => {
  prepare(sql: string): { all(...p: unknown[]): unknown[]; get(...p: unknown[]): any; run(...p: unknown[]): unknown };
  exec(sql: string): unknown;
  transaction(fn: (...a: unknown[]) => unknown): (...a: unknown[]) => unknown;
  sync(): unknown;
};
const db = new Libsql(replica, { syncUrl: url, authToken: token, readYourWrites: true });
db.sync();

db.exec("DROP TABLE IF EXISTS probe"); // clean up the connectivity-probe table from earlier testing
db.exec(
  `CREATE TABLE IF NOT EXISTS neurons (
     id TEXT PRIMARY KEY, text TEXT NOT NULL, answer TEXT NOT NULL DEFAULT '',
     citation TEXT NOT NULL DEFAULT '', edges TEXT NOT NULL DEFAULT '[]',
     embedding TEXT, embedding_model TEXT
   )`
);

const before = (db.prepare("SELECT COUNT(*) AS n FROM neurons").get() as { n: number }).n;
console.log("cloud rows before:", before);

// Each write on an embedded replica is a network round-trip to the primary, so a row-at-a-time loop
// of 3800 inserts is painfully slow. Batch many rows per INSERT to collapse it to a handful of trips.
const t0 = performance.now();
const CHUNK = 500; // 500 rows × 7 columns = 3500 bound params/statement, well under SQLite's limit
let done = 0;
for (let i = 0; i < rows.length; i += CHUNK) {
  const slice = rows.slice(i, i + CHUNK);
  const values = slice.map(() => "(?,?,?,?,?,?,?)").join(",");
  const params: Array<string | null> = [];
  for (const r of slice) {
    params.push(r.id, r.text, r.answer, r.citation, r.edges, r.embedding, r.embedding_model ?? null);
  }
  db.prepare(
    `INSERT OR REPLACE INTO neurons (id, text, answer, citation, edges, embedding, embedding_model) VALUES ${values}`
  ).run(...params);
  done += slice.length;
  console.log(`  inserted ${done}/${rows.length}`);
}
db.sync();
const secs = ((performance.now() - t0) / 1000).toFixed(1);

const after = (db.prepare("SELECT COUNT(*) AS n FROM neurons").get() as { n: number }).n;
const embedded = (db.prepare("SELECT COUNT(*) AS n FROM neurons WHERE embedding IS NOT NULL").get() as { n: number }).n;
console.log(`cloud rows after : ${after} (with embedding: ${embedded}) in ${secs}s`);
console.log(after >= rows.length ? "OK migration complete" : "WARN: cloud count is below source count");
