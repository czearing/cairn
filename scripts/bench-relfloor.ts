// Compare "raise the threshold" options on the real brain (point CAIRN_DB_PATH at a COPY):
//   abs T        : keep score >= T            (fixed threshold)
//   relfloor R   : keep score >= max(0.3, R*top)   (adaptive, per-query)
// Shows result counts per query so we can pick a value that crushes the worst floods without
// starving narrow queries.
import { Database } from "bun:sqlite";
import { pipeline } from "@huggingface/transformers";

const d = new Database(process.env.CAIRN_DB_PATH!, { readonly: true });
const rows = (d.query("SELECT embedding FROM neurons WHERE embedding IS NOT NULL").all() as { embedding: string }[])
  .map((r) => JSON.parse(r.embedding) as number[]).filter((v) => v.length === 384);
const extract = await pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2");
const embed = async (t: string) => Array.from((await extract(t, { pooling: "mean", normalize: true })).data as Float32Array);
const dot = (a: number[], b: number[]) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!; return s; };

const queries = [
  "where does cairn store its database by default",
  "how is the installer tested",
  "how do we make the brain shareable across a team",
  "what is the best embedding model to use",
  "the migratory patterns of arctic terns",
];
console.log("query                                       top | abs.5 abs.6 | rf.5 rf.6 rf.7");
console.log("-".repeat(80));
for (const q of queries) {
  const qv = await embed(q);
  const sims = rows.map((v) => dot(qv, v)).sort((a, b) => b - a);
  const top = sims[0]!;
  const abs = (t: number) => sims.filter((s) => s >= t).length;
  const rf = (r: number) => { const floor = Math.max(0.3, r * top); return sims.filter((s) => s >= floor).length; };
  console.log(`${q.slice(0, 42).padEnd(44)} ${top.toFixed(2)} | ${String(abs(0.5)).padStart(4)} ${String(abs(0.6)).padStart(5)} | ${String(rf(0.5)).padStart(4)} ${String(rf(0.6)).padStart(4)} ${String(rf(0.7)).padStart(4)}`);
}
