// One-time bulk conversion of legacy JSON-string embeddings to packed float32 BLOBs. Idempotent and
// lossless (the JSON values were already float32-origin). Selects only `text`-typed rows via SQLite's
// typeof(), so BLOB rows are skipped. Operates on CAIRN_DB_PATH (default ~/.cairn/cairn.db).
// BACK UP FIRST. The read path also accepts legacy JSON, so this is an optimization, not a requirement.
import { Database } from "bun:sqlite";
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { encodeVector } from "../src/core/vector";

const path = process.env.CAIRN_DB_PATH || join(homedir(), ".cairn", "cairn.db");
const sizeMB = () => (statSync(path).size / 1048576).toFixed(1);
console.log("db:", path);
console.log("size before:", sizeMB(), "MB");

const d = new Database(path);
const legacy = d.query("SELECT id, embedding FROM neurons WHERE typeof(embedding) = 'text'").all() as { id: string; embedding: string }[];
console.log("legacy JSON-string embeddings:", legacy.length);

const upd = d.query("UPDATE neurons SET embedding = ? WHERE id = ?");
let migrated = 0, skipped = 0;
const run = d.transaction((items: { id: string; embedding: string }[]) => {
  for (const r of items) {
    try {
      const v = JSON.parse(r.embedding);
      if (Array.isArray(v) && v.length > 0) { upd.run(encodeVector(v), r.id); migrated++; } else skipped++;
    } catch { skipped++; }
  }
});
run(legacy);

d.run("VACUUM"); // reclaim the space freed by the smaller blobs
console.log(`migrated: ${migrated}  skipped: ${skipped}`);
const blobs = (d.query("SELECT COUNT(*) n FROM neurons WHERE typeof(embedding) = 'blob'").get() as { n: number }).n;
const texts = (d.query("SELECT COUNT(*) n FROM neurons WHERE typeof(embedding) = 'text'").get() as { n: number }).n;
console.log(`now: ${blobs} blob, ${texts} text (legacy remaining)`);
console.log("size after:", sizeMB(), "MB");
