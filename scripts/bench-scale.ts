// LOCAL ONLY. Measures the two scale problems prior research didn't: (1) graph redundancy — how many
// nodes have a near-duplicate twin (motivates write-time dedup), and (2) brute-force scan latency at
// the current size, projected to larger n (motivates an ANN index). Read-only on the real brain.
import { Database } from "bun:sqlite";
import { pipeline } from "@huggingface/transformers";

const d = new Database(process.env.HOME + "/.cairn/cairn.db", { readonly: true });
const rows = (d.query("SELECT id, text, embedding FROM neurons WHERE embedding IS NOT NULL").all() as
  { id: string; text: string; embedding: string }[])
  .map((r) => ({ id: r.id, text: r.text, vec: JSON.parse(r.embedding) as number[] }))
  .filter((r) => r.vec.length === 384);
const N = rows.length;
console.log(`nodes with 384-dim vectors: ${N}`);

const dot = (a: number[], b: number[]) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!; return s; };

// --- (1) redundancy: sample S nodes, find each one's nearest neighbor (excluding self) over all N ---
const S = Math.min(500, N);
const step = Math.floor(N / S);
const buckets = { ">0.97": 0, "0.93-0.97": 0, "0.88-0.93": 0, "0.80-0.88": 0, "<0.80": 0 };
let sumMax = 0;
const examples: string[] = [];
for (let s = 0; s < N; s += step) {
  const a = rows[s]!;
  let max = -1, argmax = -1;
  for (let j = 0; j < N; j++) { if (j === s) continue; const v = dot(a.vec, rows[j]!.vec); if (v > max) { max = v; argmax = j; } }
  sumMax += max;
  if (max > 0.97) buckets[">0.97"]++; else if (max > 0.93) buckets["0.93-0.97"]++;
  else if (max > 0.88) buckets["0.88-0.93"]++; else if (max > 0.80) buckets["0.80-0.88"]++; else buckets["<0.80"]++;
  if (max > 0.95 && examples.length < 6) examples.push(`  ${max.toFixed(3)}  "${a.text.slice(0, 48)}"  ~  "${rows[argmax]!.text.slice(0, 48)}"`);
}
const sampled = Object.values(buckets).reduce((a, b) => a + b, 0);
console.log(`\n--- redundancy (nearest-neighbor cosine for ${sampled} sampled nodes) ---`);
for (const [k, v] of Object.entries(buckets)) console.log(`  NN cosine ${k.padEnd(10)}: ${v}  (${(100 * v / sampled).toFixed(1)}%)`);
console.log(`  mean nearest-neighbor cosine: ${(sumMax / sampled).toFixed(3)}`);
console.log(`  near-duplicate examples (NN > 0.95):`);
examples.forEach((e) => console.log(e));

// --- (2) scan latency: embed one query, then time the pure O(n) cosine scan ---
const extract = await pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2");
const qv = Array.from((await extract("how does cairn keep search relevant at scale", { pooling: "mean", normalize: true })).data as Float32Array);
const t0 = performance.now();
const sims = rows.map((r) => dot(qv, r.vec));
const scanMs = performance.now() - t0;
sims.sort((a, b) => b - a);
console.log(`\n--- scan latency ---`);
console.log(`  pure cosine scan over ${N} vectors: ${scanMs.toFixed(1)} ms`);
console.log(`  per-vector: ${(scanMs / N * 1000).toFixed(2)} µs  →  projected: 10k=${(scanMs / N * 10000).toFixed(0)}ms  50k=${(scanMs / N * 50000).toFixed(0)}ms  200k=${(scanMs / N * 200000).toFixed(0)}ms`);
console.log(`  top-5 sims: ${sims.slice(0, 5).map((s) => s.toFixed(3)).join(", ")}`);
