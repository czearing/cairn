// Does removing embedding anisotropy improve discrimination? Transformer sentence vectors occupy a
// narrow cone, so even unrelated texts score cosine ~0.2-0.3 — a noise floor that floods threshold
// results. Post-processing tested (all MiniLM, query raw):
//   base      cosine on the unit vectors (current)
//   center    subtract the corpus mean, renormalize, then cosine            (de-anisotropy)
//   abtt1     subtract mean AND remove the top-1 principal component        (all-but-the-top, k=1)
//
// Part A: synthetic clustered corpus with ground truth -> MRR / r@1 / margin.
// Part B: the REAL brain (point CAIRN_DB_PATH at a COPY) -> how far the true top sits above the
//         noise floor (top-1 vs mean of ranks 50-150), a scale-invariant separation signal.
import { pipeline } from "@huggingface/transformers";
import { DOCS, QUERIES } from "./bench-corpus";

const dot = (a: number[], b: number[]) => { let s = 0; const n = Math.min(a.length, b.length); for (let i = 0; i < n; i++) s += a[i]! * b[i]!; return s; };
const norm = (v: number[]) => { let n = 0; for (const x of v) n += x * x; n = Math.sqrt(n) || 1; return v.map((x) => x / n); };
const mean = (vs: number[][]) => { const m = new Array(vs[0]!.length).fill(0); for (const v of vs) for (let i = 0; i < v.length; i++) m[i] += v[i]!; return m.map((x) => x / vs.length); };
const sub = (a: number[], b: number[]) => a.map((x, i) => x - b[i]!);

// Top principal component of mean-centered vectors via power iteration (no deps).
function topPC(centered: number[][], iters = 30): number[] {
  const d = centered[0]!.length;
  let v = norm(new Array(d).fill(0).map((_, i) => Math.sin(i + 1)));
  for (let it = 0; it < iters; it++) {
    const next = new Array(d).fill(0);
    for (const x of centered) { const c = dot(x, v); for (let i = 0; i < d; i++) next[i] += c * x[i]!; }
    v = norm(next);
  }
  return v;
}
const removeComp = (v: number[], c: number[]) => { const p = dot(v, c); return v.map((x, i) => x - p * c[i]!); };

const extract = await pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2");
const embed = async (t: string) => {
  const out = await extract(t && t.trim() ? t : " ", { pooling: "mean", normalize: true });
  return Array.from(out.data as Float32Array);
};

// ---------- Part A: synthetic ground-truth ----------
const docVec = new Map<string, number[]>();
for (const d of DOCS) docVec.set(d.id, await embed(`${d.text} ${d.answer}`.trim()));
const qVec = new Map<string, number[]>();
for (const { q } of QUERIES) if (!qVec.has(q)) qVec.set(q, await embed(q));

const mu = mean([...docVec.values()]);
const centeredDocs = [...docVec.values()].map((v) => sub(v, mu));
const pc1 = topPC(centeredDocs);

function transform(v: number[], mode: string): number[] {
  if (mode === "base") return v;
  if (mode === "center") return norm(sub(v, mu));
  return norm(removeComp(sub(v, mu), pc1)); // abtt1
}

function evalMode(mode: string) {
  const dv = new Map([...docVec].map(([id, v]) => [id, transform(v, mode)]));
  let rr = 0, r1 = 0, ms = 0, cs = 0, ws = 0;
  for (const { q, target } of QUERIES) {
    const qv = transform(qVec.get(q)!, mode);
    const ranked = DOCS.map((d) => ({ id: d.id, sim: dot(qv, dv.get(d.id)!) })).sort((a, b) => b.sim - a.sim);
    const rank = ranked.findIndex((r) => r.id === target) + 1;
    rr += 1 / rank; if (rank === 1) r1++;
    const correct = ranked.find((r) => r.id === target)!.sim;
    const bestWrong = ranked.find((r) => r.id !== target)!.sim;
    cs += correct; ws += bestWrong; ms += correct - bestWrong;
  }
  const n = QUERIES.length;
  return { mrr: rr / n, r1: r1 / n, correct: cs / n, bestWrong: ws / n, margin: ms / n };
}

const f = (x: number) => x.toFixed(3);
console.log("=== Part A: synthetic clustered corpus (MiniLM, raw query) ===");
console.log("mode      MRR    r@1   | cos:correct cos:bestWrong margin");
for (const mode of ["base", "center", "abtt1"]) {
  const m = evalMode(mode);
  console.log(`${mode.padEnd(8)}  ${f(m.mrr)}  ${f(m.r1)}  |   ${f(m.correct)}      ${f(m.bestWrong)}     ${f(m.margin)}`);
}

// ---------- Part B: real brain separation (optional, needs CAIRN_DB_PATH copy) ----------
const dbPath = process.env.CAIRN_DB_PATH;
if (dbPath) {
  const { Database } = await import("bun:sqlite");
  const d = new Database(dbPath, { readonly: true });
  const rows = (d.query("SELECT text, embedding FROM neurons WHERE embedding IS NOT NULL").all() as { text: string; embedding: string }[])
    .map((r) => ({ text: r.text, v: JSON.parse(r.embedding) as number[] }))
    .filter((r) => r.v.length === 384);
  const muR = mean(rows.map((r) => r.v));
  const centeredR = rows.map((r) => sub(r.v, muR));
  const pcR = topPC(centeredR.slice(0, 1500)); // sample for speed

  const tf = (v: number[], mode: string) => mode === "base" ? v : mode === "center" ? norm(sub(v, muR)) : norm(removeComp(sub(v, muR), pcR));
  const queries = [
    "how do we improve the quality and accuracy of semantic search results",
    "how do we make the brain shareable across a team",
    "what is the best embedding model to use",
  ];
  console.log(`\n=== Part B: real brain separation (n=${rows.length}) — top1 vs noise floor (mean of ranks 50-150) ===`);
  console.log("query                                            mode    top1   floor   spread");
  for (const q of queries) {
    const base = await embed(q);
    for (const mode of ["base", "center", "abtt1"]) {
      const qv = tf(base, mode);
      const sims = rows.map((r) => dot(qv, tf(r.v, mode))).sort((a, b) => b - a);
      const top1 = sims[0]!;
      const floor = sims.slice(50, 150).reduce((s, x) => s + x, 0) / 100;
      console.log(`${q.slice(0, 46).padEnd(48)} ${mode.padEnd(6)} ${f(top1)}  ${f(floor)}  ${f(top1 - floor)}`);
    }
  }
}
