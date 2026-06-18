// Measures, on a COPY of the real brain, whether binary-quantization + float rerank (search stage ②)
// keeps recall while slashing the scan cost. For each sample query we compute the float32 top-10
// (ground truth = what search returns today), then the binary pipeline: sign-quantize every vector to
// a 384-bit (48-byte) signature, rank all by Hamming distance, take the top (10 × oversample) as a
// shortlist, rerank that shortlist by full float cosine, and keep 10. recall@10 = overlap / 10.
//
// Read-only; never writes. Point it at a brain with CAIRN_DB_PATH (defaults to the cloud replica, then
// the local file). Run: bun scripts/bench-binary-quant.ts
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { embed } from "../src/core/embed";
import { decodeVector } from "../src/core/vector";

const candidates = [
  process.env.CAIRN_DB_PATH,
  join(homedir(), ".cairn", "cairn-replica.db"),
  join(homedir(), ".cairn", "cairn.db"),
].filter(Boolean) as string[];
const path = candidates.find((p) => existsSync(p));
if (!path) { console.error("no brain db found"); process.exit(1); }
console.log("db:", path);

const d = new Database(path, { readonly: true });
const rows = d.query("SELECT id, text, answer, embedding FROM neurons").all() as
  { id: string; text: string; answer: string; embedding: unknown }[];

// The model's dimension comes from a probe embed; keep only vectors that match it (skip legacy/odd).
const probe = await embed("dimension probe");
const DIM = probe.length;
const norm = (v: number[]): Float32Array => {
  let s = 0; for (const x of v) s += x * x;
  const inv = s > 0 ? 1 / Math.sqrt(s) : 0;
  const o = new Float32Array(v.length); for (let i = 0; i < v.length; i++) o[i] = v[i]! * inv;
  return o;
};
const items = rows
  .map((r) => { const v = decodeVector(r.embedding); return v && v.length === DIM ? { id: r.id, text: r.text, answer: r.answer, vec: norm(v) } : null; })
  .filter(Boolean) as { id: string; text: string; answer: string; vec: Float32Array }[];
console.log(`vectors: ${items.length} / ${rows.length} rows at dim ${DIM}`);
if (items.length < 50) { console.error("brain too small to benchmark meaningfully"); process.exit(1); }

// --- binary signatures: one sign-bit per dim, packed into ceil(DIM/8) bytes ---
const BYTES = (DIM + 7) >> 3;
const sign = (v: Float32Array): Uint8Array => {
  const b = new Uint8Array(BYTES);
  for (let i = 0; i < v.length; i++) if (v[i]! >= 0) b[i >> 3] = b[i >> 3]! | (1 << (i & 7));
  return b;
};
const POP = new Uint8Array(256); for (let i = 0; i < 256; i++) POP[i] = (i & 1) + POP[i >> 1]!;
const hamming = (a: Uint8Array, b: Uint8Array): number => { let s = 0; for (let i = 0; i < BYTES; i++) s += POP[a[i]! ^ b[i]!]!; return s; };
const dot = (a: Float32Array, b: Float32Array): number => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!; return s; };

const sigs = items.map((it) => sign(it.vec));

// --- sample queries: use real node texts so the queries are in-distribution ---
const K = 10;
const Q = Math.min(60, items.length);
const step = Math.max(1, Math.floor(items.length / Q));
const queries: { qv: Float32Array; truth: Set<string> }[] = [];
let floatMs = 0;
for (let i = 0; i < items.length && queries.length < Q; i += step) {
  const qv = norm(await embed(`${items[i]!.text} ${items[i]!.answer}`.trim()));
  const t0 = performance.now();
  const scored = items.map((it, j) => ({ j, s: dot(qv, it.vec) })).sort((a, b) => b.s - a.s).slice(0, K);
  floatMs += performance.now() - t0;
  queries.push({ qv, truth: new Set(scored.map((x) => items[x.j]!.id)) });
}

console.log(`\nqueries: ${queries.length}  K=${K}  signature: ${BYTES}B vs float ${DIM * 4}B (${((DIM * 4) / BYTES).toFixed(0)}x smaller)\n`);
console.log("oversample  recall@10  shortlist  hammingMs(total)");
for (const over of [1, 2, 3, 4, 8]) {
  const shortlist = K * over;
  let hit = 0, hMs = 0;
  for (const { qv, truth } of queries) {
    const qsig = sign(qv);
    const t0 = performance.now();
    const cand = sigs.map((s, j) => ({ j, h: hamming(qsig, s) })).sort((a, b) => a.h - b.h).slice(0, shortlist);
    const rer = cand.map((c) => ({ j: c.j, s: dot(qv, items[c.j]!.vec) })).sort((a, b) => b.s - a.s).slice(0, K);
    hMs += performance.now() - t0;
    const got = new Set(rer.map((x) => items[x.j]!.id));
    for (const id of truth) if (got.has(id)) hit++;
  }
  const recall = hit / (queries.length * K);
  console.log(`${String(over).padEnd(11)} ${recall.toFixed(3).padEnd(10)} ${String(shortlist).padEnd(10)} ${hMs.toFixed(1)}`);
}
console.log(`\nfloat full-scan total: ${floatMs.toFixed(1)}ms for ${queries.length} queries (${(floatMs / queries.length).toFixed(2)}ms/query over ${items.length} vecs)`);
