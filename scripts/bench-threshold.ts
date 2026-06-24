// Threshold recalibration on the real brain (point CAIRN_DB_PATH at a COPY). MiniLM's noise floor is
// ~0.09, so the 0.3 default admits a weakly-related tail. Sweep thresholds: for each query show how
// many neurons clear it and whether the known-correct top result survives. An out-of-domain query
// should drop to ~0 once the threshold passes the noise floor.
import { Database } from "bun:sqlite";
import { pipeline } from "@huggingface/transformers";

const d = new Database(process.env.CAIRN_DB_PATH!, { readonly: true });
const rows = (d.query("SELECT text, embedding FROM neurons WHERE embedding IS NOT NULL").all() as { text: string; embedding: string }[])
  .map((r) => ({ text: r.text, v: JSON.parse(r.embedding) as number[] }))
  .filter((r) => r.v.length === 384);

const extract = await pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2");
const embed = async (t: string) => Array.from((await extract(t, { pooling: "mean", normalize: true })).data as Float32Array);
const dot = (a: number[], b: number[]) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!; return s; };

const THRESH = [0.3, 0.35, 0.4, 0.45, 0.5];
const queries = [
  "where does cairn store its database by default",
  "how is the installer tested",
  "how do we make the brain shareable across a team",
  "what is the best embedding model to use",
  "the migratory patterns of arctic terns",   // OUT OF DOMAIN — should go to ~0
];

console.log(`n=${rows.length}\nquery                                          ` + THRESH.map((t) => `>=${t}`).join("   "));
console.log("-".repeat(86));
for (const q of queries) {
  const qv = await embed(q);
  const sims = rows.map((r) => dot(qv, r.v)).sort((a, b) => b - a);
  const counts = THRESH.map((t) => sims.filter((s) => s >= t).length);
  console.log(`${q.slice(0, 44).padEnd(46)} ` + counts.map((c) => String(c).padStart(5)).join("   ") + `   (top ${sims[0]!.toFixed(2)})`);
}
