// Labeled precision/recall eval for anisotropy correction, gating whether ABTT ships as the default.
// Ground truth = the brain's own graph: for a query built from node X's question, the RELEVANT set is
// X plus its directly-linked neighbors (the user-authored edges). We replicate the production floor
// (keep score >= max(0.3, 0.7*top)) and, per method, measure at that floor: self-recall (does X pass?),
// NEIGHBOR-RECALL (do X's true neighbors still pass? — the safety metric, must not drop), precision
// (retrieved that are relevant / retrieved), and mean false positives (the flood we want to cut).
// Read-only. Run: bun scripts/eval-precision.ts
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { embed } from "../src/core/embed";
import { decodeVector } from "../src/core/vector";

const path = [process.env.CAIRN_DB_PATH, join(homedir(), ".cairn", "cairn-replica.db"), join(homedir(), ".cairn", "cairn.db")]
  .filter(Boolean).find((p) => existsSync(p as string)) as string;
const d = new Database(path, { readonly: true });
const rows = d.query("SELECT id, text, answer, edges, embedding FROM neurons").all() as
  { id: string; text: string; answer: string; edges: string; embedding: unknown }[];

const probe = await embed("dimension probe");
const DIM = probe.length;
const l2 = (v: Float32Array): Float32Array => { let s = 0; for (const x of v) s += x * x; const inv = s > 0 ? 1 / Math.sqrt(s) : 0; const o = new Float32Array(v.length); for (let i = 0; i < v.length; i++) o[i] = v[i]! * inv; return o; };
const items = rows.map((r) => {
  const v = decodeVector(r.embedding); if (!v || v.length !== DIM) return null;
  let edges: string[] = []; try { edges = JSON.parse(r.edges); } catch { /* */ }
  return { id: r.id, text: r.text, edges, vec: new Float32Array(v) };
}).filter(Boolean) as { id: string; text: string; edges: string[]; vec: Float32Array }[];
const N = items.length;
const idx = new Map(items.map((it, i) => [it.id, i]));
const dot = (a: Float32Array, b: Float32Array): number => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!; return s; };

// mean + top-k principal components (power iteration) over the centered corpus
const mean = new Float32Array(DIM); for (const it of items) for (let i = 0; i < DIM; i++) mean[i]! += it.vec[i]! / N;
function fitPCs(k: number): Float32Array[] {
  const work = items.map((it) => { const c = new Float32Array(DIM); for (let i = 0; i < DIM; i++) c[i] = it.vec[i]! - mean[i]!; return c; });
  const comps: Float32Array[] = [];
  for (let c = 0; c < k; c++) {
    let u: Float32Array = new Float32Array(DIM); for (let i = 0; i < DIM; i++) u[i] = Math.sin(i + c + 1); u = l2(u);
    for (let iter = 0; iter < 30; iter++) { const nx = new Float32Array(DIM); for (const v of work) { const p = dot(v, u); for (let i = 0; i < DIM; i++) nx[i]! += p * v[i]!; } u = l2(nx); }
    comps.push(u); for (const v of work) { const p = dot(v, u); for (let i = 0; i < DIM; i++) v[i]! -= p * u[i]!; }
  }
  return comps;
}
const transform = (raw: Float32Array, pcs: Float32Array[]): Float32Array => {
  const c = new Float32Array(DIM); for (let i = 0; i < DIM; i++) c[i] = raw[i]! - mean[i]!;
  for (const u of pcs) { const p = dot(c, u); for (let i = 0; i < DIM; i++) c[i]! -= p * u[i]!; }
  return l2(c);
};

const ABS = 0.3, REL = 0.7; // production gate
// Sample nodes that have at least one neighbor present in the corpus (so neighbor-recall is defined).
const sample = items.map((it, i) => i).filter((i) => items[i]!.edges.some((e) => idx.has(e))).filter((_, n) => n % 7 === 0).slice(0, 120);
const queries = await Promise.all(sample.map(async (i) => ({ i, qraw: new Float32Array(await embed(items[i]!.text)) })));

console.log(`db: ${path}  vectors: ${N}  queries: ${queries.length} (nodes with >=1 neighbor)\n`);
console.log("method      retrieved  self-rec  neighbor-rec  precision  falsePos");
const methods: { label: string; center: boolean; k: number }[] = [
  { label: "baseline", center: false, k: 0 },
  { label: "mean-only", center: true, k: 0 },
  { label: "ABTT-1", center: true, k: 1 },
  { label: "ABTT-2", center: true, k: 2 },
];
for (const m of methods) {
  const pcs = m.center ? fitPCs(m.k) : [];
  const corpus = m.center ? items.map((it) => transform(it.vec, pcs)) : items.map((it) => it.vec);
  let retSum = 0, selfHit = 0, nbrHit = 0, nbrTot = 0, precSum = 0, fpSum = 0;
  for (const { i, qraw } of queries) {
    const qv = m.center ? transform(qraw, pcs) : l2(qraw);
    let top = -2; const sc = new Float64Array(N);
    for (let j = 0; j < N; j++) { const s = dot(qv, corpus[j]!); sc[j] = s; if (s > top) top = s; }
    const floor = Math.max(ABS, REL * top);
    const relevant = new Set<number>([i, ...items[i]!.edges.map((e) => idx.get(e)).filter((x): x is number => x !== undefined)]);
    let retrieved = 0, tp = 0;
    for (let j = 0; j < N; j++) if (sc[j]! >= floor) { retrieved++; if (relevant.has(j)) tp++; }
    retSum += retrieved;
    if (sc[i]! >= floor) selfHit++;
    for (const e of items[i]!.edges) { const j = idx.get(e); if (j === undefined) continue; nbrTot++; if (sc[j]! >= floor) nbrHit++; }
    precSum += tp / Math.max(1, retrieved);
    fpSum += retrieved - tp;
  }
  const Q = queries.length;
  console.log(`${m.label.padEnd(11)} ${(retSum / Q).toFixed(2).padEnd(9)}  ${(selfHit / Q).toFixed(3).padEnd(8)}  ${(nbrHit / nbrTot).toFixed(3).padEnd(12)}  ${(precSum / Q).toFixed(3).padEnd(9)}  ${(fpSum / Q).toFixed(2)}`);
}
console.log("\nSHIP gate: neighbor-rec must NOT drop vs k=0 while falsePos falls and precision rises.");
