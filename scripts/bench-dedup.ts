// How much of the above-threshold tail is REDUNDANT (near-duplicate neurons) vs genuinely distinct?
// Collapsing near-duplicates cuts perceived bloat without dropping any distinct fact and without a
// count cap. Point CAIRN_DB_PATH at a COPY. Greedy dedup: keep a result only if its max cosine to
// an already-kept result is below T.
import { pipeline } from "@huggingface/transformers";
import { Database } from "bun:sqlite";

const d = new Database(process.env.CAIRN_DB_PATH!, { readonly: true });
const rows = (d.query("SELECT text, embedding FROM neurons WHERE embedding IS NOT NULL").all() as { text: string; embedding: string }[])
  .map((r) => ({ text: r.text, v: JSON.parse(r.embedding) as number[] }))
  .filter((r) => r.v.length === 384);

const extract = await pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2");
const embed = async (t: string) => Array.from((await extract(t, { pooling: "mean", normalize: true })).data as Float32Array);
const dot = (a: number[], b: number[]) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!; return s; };

function dedup(items: { text: string; v: number[] }[], T: number) {
  const kept: { text: string; v: number[] }[] = [];
  const absorbed: [string, string][] = [];
  for (const it of items) {
    let dupOf: string | null = null;
    for (const k of kept) if (dot(it.v, k.v) >= T) { dupOf = k.text; break; }
    if (dupOf) absorbed.push([it.text, dupOf]); else kept.push(it);
  }
  return { kept, absorbed };
}

const queries = [
  "where does cairn store its database by default",
  "how is the installer tested",
  "what is the best embedding model to use",
];
const f = (x: number) => x.toFixed(2);
for (const q of queries) {
  const qv = await embed(q);
  const band = rows.map((r) => ({ ...r, sim: dot(qv, r.v) })).filter((r) => r.sim >= 0.3).sort((a, b) => b.sim - a.sim);
  console.log(`Q: ${q}  (above 0.3: ${band.length})`);
  for (const T of [0.95, 0.9, 0.85]) {
    const { kept, absorbed } = dedup(band, T);
    console.log(`   T=${T}: ${band.length} -> ${kept.length} kept, ${absorbed.length} absorbed as near-dupes`);
    if (T === 0.9) for (const [dup, of] of absorbed.slice(0, 4)) console.log(`       "${dup.slice(0, 48)}"  ~=  "${of.slice(0, 48)}"`);
  }
  console.log();
}
