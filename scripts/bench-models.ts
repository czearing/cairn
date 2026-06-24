// Embedding-model bake-off for the ROOT search-bloat fix: which model best SEPARATES relevant from
// irrelevant, so a threshold can cleanly cut the noise (vs MiniLM's smooth gradient)? Ranking alone
// isn't the metric — separation is. On the clustered ground-truth corpus we measure, per model:
//   MRR / recall@1   — ranking sanity (must not regress)
//   AUC              — P(a true-positive query→target scores above a cross-cluster true-negative);
//                      1.0 = perfectly separable by a threshold
//   FP@recall1.0     — at the threshold that keeps EVERY true positive, what fraction of clearly-
//                      irrelevant cross-cluster pairs still sneak above it (the bloat, in miniature)
//   noise-floor      — mean max-cosine for OUT-OF-DOMAIN queries (lower = better noise rejection)
// Run: bun scripts/bench-models.ts
import { pipeline } from "@huggingface/transformers";
import { DOCS, QUERIES } from "./bench-corpus";

const MODELS = [
  { name: "MiniLM-L6   (current)", model: "Xenova/all-MiniLM-L6-v2", qp: "", dp: "" },
  { name: "bge-small-en-v1.5    ", model: "Xenova/bge-small-en-v1.5", qp: "Represent this sentence for searching relevant passages: ", dp: "" },
  { name: "bge-base-en-v1.5     ", model: "Xenova/bge-base-en-v1.5", qp: "Represent this sentence for searching relevant passages: ", dp: "" },
  { name: "gte-small            ", model: "Xenova/gte-small", qp: "", dp: "" },
  { name: "gte-base             ", model: "Xenova/gte-base", qp: "", dp: "" },
];

const NOISE = [
  "the migratory patterns of arctic terns in winter",
  "how to tune a violin to concert pitch",
  "the chemistry of vulcanizing rubber",
  "rules of cricket for a test match",
];

const cluster = (id: string) => id.slice(0, 2);
const dot = (a: number[], b: number[]) => { let s = 0; const n = Math.min(a.length, b.length); for (let i = 0; i < n; i++) s += a[i]! * b[i]!; return s; };

async function evalModel(model: string, qp: string, dp: string) {
  const extract = await pipeline("feature-extraction", model);
  const embed = async (t: string) => Array.from((await extract(t && t.trim() ? t : " ", { pooling: "mean", normalize: true })).data as Float32Array);

  const docVec = new Map<string, number[]>();
  for (const d of DOCS) docVec.set(d.id, await embed(dp + `${d.text} ${d.answer}`.trim()));

  let rr = 0, r1 = 0;
  const tp: number[] = [];
  const tn: number[] = [];
  for (const { q, target } of QUERIES) {
    const qv = await embed(qp + q);
    const scored = DOCS.map((d) => ({ id: d.id, sim: dot(qv, docVec.get(d.id)!) })).sort((a, b) => b.sim - a.sim);
    const rank = scored.findIndex((s) => s.id === target) + 1;
    rr += 1 / rank; if (rank === 1) r1++;
    const tc = cluster(target);
    tp.push(scored.find((s) => s.id === target)!.sim);
    for (const s of scored) if (cluster(s.id) !== tc) tn.push(s.sim); // cross-cluster = clearly irrelevant
  }

  // AUC: fraction of (tp,tn) pairs where tp > tn
  let wins = 0;
  for (const a of tp) for (const b of tn) wins += a > b ? 1 : a === b ? 0.5 : 0;
  const auc = wins / (tp.length * tn.length);
  const minTP = Math.min(...tp);
  const fpAtFullRecall = tn.filter((x) => x >= minTP).length / tn.length;

  // noise floor: out-of-domain query, best (max) match into the corpus
  let noiseMax = 0;
  for (const nq of NOISE) {
    const qv = await embed(qp + nq);
    noiseMax += Math.max(...DOCS.map((d) => dot(qv, docVec.get(d.id)!)));
  }
  noiseMax /= NOISE.length;

  const meanTP = tp.reduce((s, x) => s + x, 0) / tp.length;
  const meanTN = tn.reduce((s, x) => s + x, 0) / tn.length;
  return { mrr: rr / QUERIES.length, r1: r1 / QUERIES.length, auc, fpAtFullRecall, noiseMax, meanTP, meanTN };
}

const f = (x: number) => x.toFixed(3);
console.log("model                   MRR    r@1   |  AUC    FP@rec1.0 |  meanTP meanTN  noiseFloor");
console.log("-".repeat(90));
for (const m of MODELS) {
  try {
    const r = await evalModel(m.model, m.qp, m.dp);
    console.log(`${m.name}  ${f(r.mrr)}  ${f(r.r1)}  | ${f(r.auc)}   ${f(r.fpAtFullRecall)}    |  ${f(r.meanTP)}  ${f(r.meanTN)}   ${f(r.noiseMax)}`);
  } catch (e) {
    console.log(`${m.name}  UNAVAILABLE (${e instanceof Error ? e.message.slice(0, 50) : e})`);
  }
}
