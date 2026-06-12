// Measures relevance-GATE options on a real brain (point CAIRN_DB_PATH at a COPY). The bloat comes
// from a fixed absolute cosine floor (0.3) sitting inside the anisotropy noise band. Compares:
//   fixed     count of neurons with sim >= 0.3            (current)
//   z>=k      per-query statistical outliers: (sim-mean)/std >= k   (adaptive, no count cap)
//   gap       cut at the largest drop among the sims >= 0.3 (elbow; adaptive, no count cap)
// None of these is a count cap: a query truly related to N neurons keeps N. Includes an OUT-OF-DOMAIN
// query to expose false positives the fixed floor admits.
import { pipeline } from "@huggingface/transformers";
import { Database } from "bun:sqlite";

const dbPath = process.env.CAIRN_DB_PATH!;
const d = new Database(dbPath, { readonly: true });
const rows = (d.query("SELECT text, embedding FROM neurons WHERE embedding IS NOT NULL").all() as { text: string; embedding: string }[])
  .map((r) => ({ text: r.text, v: JSON.parse(r.embedding) as number[] }))
  .filter((r) => r.v.length === 384);

const extract = await pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2");
const embed = async (t: string) => Array.from((await extract(t, { pooling: "mean", normalize: true })).data as Float32Array);
const dot = (a: number[], b: number[]) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!; return s; };

const queries = [
  "where does cairn store its database by default",
  "how is the installer tested",
  "how do we make the brain shareable across a team",
  "what is the best embedding model to use",
  "best sourdough bread recipe",           // OUT OF DOMAIN — ideally returns ~nothing
];

const f = (x: number) => x.toFixed(3);
console.log(`n=${rows.length}\n`);
for (const q of queries) {
  const qv = await embed(q);
  const sims = rows.map((r) => ({ text: r.text, sim: dot(qv, r.v) })).sort((a, b) => b.sim - a.sim);
  const vals = sims.map((s) => s.sim);
  const mean = vals.reduce((s, x) => s + x, 0) / vals.length;
  const std = Math.sqrt(vals.reduce((s, x) => s + (x - mean) ** 2, 0) / vals.length);
  const fixed = vals.filter((x) => x >= 0.3).length;
  const z = (k: number) => vals.filter((x) => (x - mean) / std >= k).length;

  // gap/elbow among the fixed-0.3 set: cut after the largest consecutive drop
  const band = sims.filter((s) => s.sim >= 0.3);
  let cut = band.length, maxGap = 0;
  for (let i = 0; i < band.length - 1; i++) { const g = band[i]!.sim - band[i + 1]!.sim; if (g > maxGap) { maxGap = g; cut = i + 1; } }

  console.log(`Q: ${q}`);
  console.log(`   top sim ${f(vals[0]!)}  mean ${f(mean)}  std ${f(std)}`);
  console.log(`   fixed≥0.3: ${fixed}   z≥1.5: ${z(1.5)}   z≥2: ${z(2)}   z≥2.5: ${z(2.5)}   z≥3: ${z(3)}   gap-cut: ${cut} (drop ${f(maxGap)})`);
  for (const s of sims.slice(0, 6)) console.log(`     ${f(s.sim)}  z=${f((s.sim - mean) / std)}  ${s.text.slice(0, 70)}`);
  console.log();
}
