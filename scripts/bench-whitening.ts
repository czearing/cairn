// Tests anisotropy correction for QUALITY, using metrics that aren't saturated like MRR. MiniLM
// vectors sit in a narrow cone, so unrelated nodes still score ~0.4-0.5 and pass the relative floor
// (the "flood"). We compare baseline cosine against mean-centering and all-but-the-top-k (ABTT,
// Mu & Viswanath) on the REAL brain, measuring per query: recall@1 (must hold), MARGIN (top minus
// runner-up, higher = cleaner separation), FLOOD (nodes passing 0.7*top, lower = fewer false
// positives), and mean random-pair cosine (isotropy proxy, lower = better). Read-only.
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { embed } from "../src/core/embed";
import { decodeVector } from "../src/core/vector";

const path = [process.env.CAIRN_DB_PATH, join(homedir(), ".cairn", "cairn-replica.db"), join(homedir(), ".cairn", "cairn.db")]
  .filter(Boolean).find((p) => existsSync(p as string)) as string;
const d = new Database(path, { readonly: true });
const rows = d.query("SELECT id, text, answer, embedding FROM neurons").all() as
  { id: string; text: string; answer: string; embedding: unknown }[];

const probe = await embed("dimension probe");
const DIM = probe.length;
const l2 = (v: Float32Array): Float32Array => { let s = 0; for (const x of v) s += x * x; const inv = s > 0 ? 1 / Math.sqrt(s) : 0; const o = new Float32Array(v.length); for (let i = 0; i < v.length; i++) o[i] = v[i]! * inv; return o; };
const items = rows.map((r) => { const v = decodeVector(r.embedding); return v && v.length === DIM ? { id: r.id, text: r.text, vec: new Float32Array(v) } : null; })
  .filter(Boolean) as { id: string; text: string; vec: Float32Array }[];
const N = items.length;
console.log(`db: ${path}  vectors: ${N} at dim ${DIM}\n`);

// Corpus mean, and the top-k principal directions of the centered corpus via power iteration.
const mean = new Float32Array(DIM);
for (const it of items) for (let i = 0; i < DIM; i++) mean[i]! += it.vec[i]! / N;
const centered = items.map((it) => { const c = new Float32Array(DIM); for (let i = 0; i < DIM; i++) c[i] = it.vec[i]! - mean[i]!; return c; });
const dot = (a: Float32Array, b: Float32Array): number => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!; return s; };
function topComponents(data: Float32Array[], k: number): Float32Array[] {
  const work = data.map((v) => new Float32Array(v)); // deflated copies
  const comps: Float32Array[] = [];
  for (let c = 0; c < k; c++) {
    let u: Float32Array = new Float32Array(DIM); for (let i = 0; i < DIM; i++) u[i] = Math.sin(i + c + 1); u = l2(u); // deterministic seed
    for (let iter = 0; iter < 30; iter++) {
      const next = new Float32Array(DIM);
      for (const v of work) { const p = dot(v, u); for (let i = 0; i < DIM; i++) next[i]! += p * v[i]!; }
      u = l2(next);
    }
    comps.push(u);
    for (const v of work) { const p = dot(v, u); for (let i = 0; i < DIM; i++) v[i]! -= p * u[i]!; } // deflate
  }
  return comps;
}
const PCs = topComponents(centered, 3);

// Transform: subtract mean, optionally remove the first `rm` principal components, renormalize.
const transform = (raw: Float32Array, rm: number): Float32Array => {
  const c = new Float32Array(DIM); for (let i = 0; i < DIM; i++) c[i] = raw[i]! - mean[i]!;
  for (let j = 0; j < rm; j++) { const p = dot(c, PCs[j]!); for (let i = 0; i < DIM; i++) c[i]! -= p * PCs[j]![i]!; }
  return l2(c);
};
const methods: { name: string; corpus: Float32Array[]; xf: (q: Float32Array) => Float32Array }[] = [
  { name: "baseline", corpus: items.map((it) => it.vec), xf: (q) => q },
  { name: "mean-center", corpus: items.map((it) => transform(it.vec, 0)), xf: (q) => transform(q, 0) },
  { name: "ABTT-1", corpus: items.map((it) => transform(it.vec, 1)), xf: (q) => transform(q, 1) },
  { name: "ABTT-2", corpus: items.map((it) => transform(it.vec, 2)), xf: (q) => transform(q, 2) },
  { name: "ABTT-3", corpus: items.map((it) => transform(it.vec, 3)), xf: (q) => transform(q, 3) },
];

// Isotropy proxy: mean cosine over fixed random pairs (lower is more isotropic).
const pairs = Array.from({ length: 2000 }, (_, i) => [(i * 7919) % N, (i * 104729 + 3) % N] as const);

// Queries: each node's QUESTION text embedded fresh (realistic Q -> Q+A asymmetric match).
const Q = Math.min(80, N), step = Math.max(1, Math.floor(N / Q));
const samples: { qraw: Float32Array; srcIdx: number }[] = [];
for (let i = 0; i < N && samples.length < Q; i += step) samples.push({ qraw: new Float32Array(await embed(items[i]!.text)), srcIdx: i });

console.log("method       recall@1  margin   flood@0.7  iso(rand-pair cos)");
for (const m of methods) {
  let r1 = 0, margin = 0, flood = 0;
  for (const { qraw, srcIdx } of samples) {
    const qv = m.xf(qraw);
    let top = -2, second = -2, topIdx = -1;
    const scores = new Float64Array(N);
    for (let j = 0; j < N; j++) { const s = dot(qv, m.corpus[j]!); scores[j] = s; if (s > top) { second = top; top = s; topIdx = j; } else if (s > second) second = s; }
    if (topIdx === srcIdx) r1++;
    margin += top - second;
    const bar = 0.7 * top;
    for (let j = 0; j < N; j++) if (scores[j]! >= bar) flood++;
  }
  let iso = 0; for (const [a, b] of pairs) iso += dot(m.corpus[a]!, m.corpus[b]!); iso /= pairs.length;
  console.log(`${m.name.padEnd(12)} ${(r1 / Q).toFixed(3).padEnd(9)} ${(margin / Q).toFixed(4).padEnd(8)} ${(flood / Q).toFixed(1).padEnd(10)} ${iso.toFixed(4)}`);
}
console.log(`\nqueries: ${Q}  (recall@1 must stay high; want higher margin, lower flood, lower iso)`);
