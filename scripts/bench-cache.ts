// Quantifies what the in-memory vector cache buys: the COLD per-query cost it removes (read all rows
// + decode every embedding) vs the WARM cost that remains (a pure in-RAM cosine scan). Read-only.
// Run: bun scripts/bench-cache.ts
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { decodeVector } from "../src/core/vector";

const path = [process.env.CAIRN_DB_PATH, join(homedir(), ".cairn", "cairn-replica.db"), join(homedir(), ".cairn", "cairn.db")]
  .filter(Boolean).find((p) => existsSync(p as string)) as string;
const d = new Database(path, { readonly: true });

let t0 = performance.now();
const rows = d.query("SELECT id, text, answer, embedding FROM neurons").all() as { embedding: unknown }[];
const vecs = rows.map((r) => decodeVector(r.embedding));
const loadMs = performance.now() - t0;

const q = vecs.find((v) => v && v.length === 384)!;
t0 = performance.now();
let best = -2;
for (const v of vecs) { if (!v) continue; let s = 0; for (let k = 0; k < 384; k++) s += q[k]! * v[k]!; if (s > best) best = s; }
const scanMs = performance.now() - t0;

console.log(`db: ${path}  rows: ${rows.length}`);
console.log(`COLD load+decode (per-query cost the cache removes): ${loadMs.toFixed(1)}ms`);
console.log(`WARM in-RAM scan (per-query cost that remains):      ${scanMs.toFixed(2)}ms`);
console.log(`per-query speedup from the cache: ${(loadMs / scanMs).toFixed(0)}x`);
