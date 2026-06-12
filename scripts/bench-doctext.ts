// Does HOW we turn a neuron into a vector change retrieval quality? Same corpus/queries as
// bench-search.ts, fixed model (MiniLM, the measured winner for short Q/A), raw query. Only the
// DOCUMENT representation varies:
//   V1 concat     embed(`${text} ${answer}`)                         (current)
//   V2 question   embed(text)                                        (ignore answer)
//   V3 avg        normalize(embed(text) + embed(answer))             (length-unbiased, equal weight)
//   V4 qweighted  normalize(0.65*embed(text) + 0.35*embed(answer))   (favor the question)
// Concatenation length-biases the vector toward whichever field has more tokens; the averaged
// variants give the question and answer equal footing regardless of length.
import { pipeline } from "@huggingface/transformers";
import { DOCS, QUERIES } from "./bench-corpus";

const dot = (a: number[], b: number[]) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!; return s; };
const norm = (v: number[]) => { let n = 0; for (const x of v) n += x * x; n = Math.sqrt(n) || 1; return v.map((x) => x / n); };
const addw = (a: number[], b: number[], wa: number, wb: number) => a.map((x, i) => wa * x + wb * b[i]!);

const extract = await pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2");
const embed = async (t: string) => {
  const out = await extract(t && t.trim() ? t : " ", { pooling: "mean", normalize: true });
  return Array.from(out.data as Float32Array);
};

type Build = (text: string, answer: string) => Promise<number[]>;
const builders: { name: string; build: Build }[] = [
  { name: "V1 concat    (current)", build: (t, a) => embed(`${t} ${a}`.trim()) },
  { name: "V2 question-only      ", build: (t) => embed(t) },
  { name: "V3 avg equal          ", build: async (t, a) => a.trim() ? norm(addw(await embed(t), await embed(a), 0.5, 0.5)) : embed(t) },
  { name: "V4 qweighted 0.65/0.35", build: async (t, a) => a.trim() ? norm(addw(await embed(t), await embed(a), 0.65, 0.35)) : embed(t) },
];

const qvecs = new Map<string, number[]>();
for (const { q } of QUERIES) if (!qvecs.has(q)) qvecs.set(q, await embed(q));

const fmt = (x: number) => x.toFixed(3);
console.log(`MiniLM-L6, raw query · corpus=${DOCS.length} queries=${QUERIES.length}\n`);
console.log("doc representation        MRR    r@1    r@3   | cos:correct cos:bestWrong margin");
console.log("-".repeat(82));
for (const { name, build } of builders) {
  const docVecs = new Map<string, number[]>();
  for (const d of DOCS) docVecs.set(d.id, await build(d.text, d.answer));
  let rr = 0, r1 = 0, r3 = 0, cs = 0, ws = 0, ms = 0;
  for (const { q, target } of QUERIES) {
    const qv = qvecs.get(q)!;
    const ranked = DOCS.map((d) => ({ id: d.id, sim: dot(qv, docVecs.get(d.id)!) })).sort((a, b) => b.sim - a.sim);
    const rank = ranked.findIndex((r) => r.id === target) + 1;
    rr += 1 / rank; if (rank === 1) r1++; if (rank <= 3) r3++;
    const correct = ranked.find((r) => r.id === target)!.sim;
    const bestWrong = ranked.find((r) => r.id !== target)!.sim;
    cs += correct; ws += bestWrong; ms += correct - bestWrong;
  }
  const n = QUERIES.length;
  console.log(`${name}  ${fmt(rr / n)}  ${fmt(r1 / n)}  ${fmt(r3 / n)}  |   ${fmt(cs / n)}      ${fmt(ws / n)}     ${fmt(ms / n)}`);
}
