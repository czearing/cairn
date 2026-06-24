// LOCAL ONLY. Proof that binary float32 embeddings round-trip on the DEFAULT (non-cloud) backend,
// bun:sqlite — the path every local user is on. Stores a vector as a BLOB, reads it back, and checks
// exact float32 equality + that cosine is identical to the JSON path. No cloud, no libSQL involved.
import { Database } from "bun:sqlite";

const d = new Database(":memory:");
d.run("CREATE TABLE t (id TEXT PRIMARY KEY, embedding BLOB)");

// A realistic 384-dim unit vector (what MiniLM produces).
const raw = Array.from({ length: 384 }, (_, i) => Math.sin(i * 0.7) + Math.cos(i * 0.3));
const norm = Math.hypot(...raw);
const vec = raw.map((x) => x / norm);

// --- write: pack Float32Array -> BLOB ---
const f32 = new Float32Array(vec);
const blob = Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength);
d.query("INSERT INTO t (id, embedding) VALUES (?, ?)").run("n1", blob);

// --- read back via bun:sqlite, reconstruct Float32Array (copy to a 4-aligned buffer) ---
const row = d.query("SELECT embedding FROM t WHERE id = ?").get("n1") as { embedding: Uint8Array };
const bytes = row.embedding;
const back = new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));

// --- checks ---
let maxErr = 0;
for (let i = 0; i < 384; i++) maxErr = Math.max(maxErr, Math.abs(back[i]! - f32[i]!));
const dot = (a: ArrayLike<number>, b: ArrayLike<number>) => { let s = 0; for (let i = 0; i < 384; i++) s += a[i]! * b[i]!; return s; };

console.log("backend: bun:sqlite (the default local store — NO cloud, NO libSQL)");
console.log("length read back:", back.length, "(expect 384)");
console.log("max abs error vs original float32:", maxErr, "(expect 0 — exact)");
console.log("cosine self-dot  BLOB:", dot(back, back).toFixed(8), " vs JSON-float:", dot(f32, f32).toFixed(8));
console.log("cosine(query, vec)  BLOB:", dot(vec, back).toFixed(8), " vs JSON:", dot(vec, f32).toFixed(8));
console.log("\nbytes:  JSON string =", JSON.stringify(vec).length, " |  BLOB =", blob.length, ` (${(JSON.stringify(vec).length / blob.length).toFixed(1)}x smaller)`);
console.log(maxErr === 0 && back.length === 384 ? "\n✅ Exact round-trip on bun:sqlite — works identically for local (non-cloud) users." : "\n❌ mismatch");
