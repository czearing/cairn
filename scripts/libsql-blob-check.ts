// Proves the CLOUD backend engine (libSQL) stores/reads the BLOB and that decodeVector handles its
// return type. Uses a plain local libSQL file — no cloud creds needed (same engine the replica uses).
import { createRequire } from "node:module";
import { existsSync, rmSync } from "node:fs";
import { encodeVector, decodeVector } from "../src/core/vector";

const path = "./scripts/.libsql-blob-check.db";
for (const f of [path, `${path}-wal`, `${path}-shm`, `${path}-client_wal_index`]) if (existsSync(f)) rmSync(f);
const Libsql = createRequire(import.meta.url)("libsql") as new (p: string) => {
  exec(s: string): unknown; prepare(s: string): { run(...a: unknown[]): unknown; get(...a: unknown[]): any };
};
const d = new Libsql(path);
d.exec("CREATE TABLE t (id TEXT PRIMARY KEY, embedding BLOB)");
const v = [0.1, -0.2, 0.333333, 1, -1];
d.prepare("INSERT INTO t (id, embedding) VALUES (?, ?)").run("x", encodeVector(v));
const row = d.prepare("SELECT embedding FROM t WHERE id = ?").get("x");
const back = decodeVector(row.embedding);
console.log("libSQL BLOB return type:", row.embedding?.constructor?.name);
console.log("decoded:", back);
const ok = JSON.stringify(back) === JSON.stringify(v.map(Math.fround));
console.log(ok ? "✅ libSQL (cloud engine) round-trips the BLOB exactly" : "❌ mismatch");
for (const f of [path, `${path}-wal`, `${path}-shm`, `${path}-client_wal_index`]) if (existsSync(f)) rmSync(f);
