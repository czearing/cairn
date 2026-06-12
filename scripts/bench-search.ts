// Controlled retrieval-quality benchmark for Cairn's semantic search.
//
// Compares three embedding configurations on a labeled Q/A corpus arranged into CONFUSABLE CLUSTERS
// (several neurons share a topic; each query must pick the ONE right neuron out of its near-siblings).
// Queries are hard paraphrases — deliberately low literal-token overlap — so this measures meaning-
// based ranking, the thing a keyword search cannot do.
//   A  Xenova/all-MiniLM-L6-v2  (current default), query embedded raw
//   B  Xenova/bge-small-en-v1.5, query embedded raw  (isolates the model upgrade)
//   C  Xenova/bge-small-en-v1.5, query embedded WITH the bge instruction prefix (proposed default)
//
// Docs embed exactly as core does: vecText = `${text} ${answer}`, mean-pooled + normalized, never
// prefixed. Only the QUERY side changes between B and C.
//
// Metrics: MRR, recall@1, recall@3 over all queries, plus mean cosine of the correct neuron, of the
// best WRONG neuron, and their margin — the separation the relevance threshold lives inside.
//
// Run from repo root:  bun scripts/bench-search.ts
import { pipeline } from "@huggingface/transformers";

const QUERY_PREFIX = "Represent this sentence for searching relevant passages: ";

interface Doc { id: string; text: string; answer: string; }
interface Query { q: string; target: string; }

// Clusters: pg* Postgres perf · au* auth · rx* React render · as* async/net · ds* distributed · mx* misc
const DOCS: Doc[] = [
  { id: "pg1", text: "How do you make a Postgres query doing a sequential scan faster?", answer: "Add an index on the filtered column so the planner uses an index scan instead of reading every row." },
  { id: "pg2", text: "How do you fix an N+1 query problem with an ORM?", answer: "Eager-load the related rows in one join/batch query instead of issuing a query per parent row." },
  { id: "pg3", text: "Why is my Postgres table getting slower and bloated over time?", answer: "Dead tuples accumulate from updates/deletes; run VACUUM (or autovacuum) to reclaim space and refresh stats." },
  { id: "pg4", text: "Why does my service run out of Postgres connections under load?", answer: "Each request opens its own connection; put a pooler like PgBouncer in front to cap and reuse connections." },

  { id: "au1", text: "What is the difference between authentication and authorization?", answer: "Authentication verifies who you are; authorization decides what you are allowed to do once identified." },
  { id: "au2", text: "How do you store user passwords securely?", answer: "Hash with a slow salted algorithm like bcrypt or Argon2; never store plaintext or fast unsalted hashes." },
  { id: "au3", text: "How do you handle expiring JWT access tokens?", answer: "Issue a short-lived access token plus a long-lived refresh token, and rotate the refresh token on use." },

  { id: "rx1", text: "Why does my React component render twice in development?", answer: "React 18 StrictMode intentionally double-invokes render and effects in dev to surface impure logic." },
  { id: "rx2", text: "Why does my useEffect run in an infinite loop?", answer: "An effect updates state that is also in its dependency array; remove the dep or memoize the value." },
  { id: "rx3", text: "Why does my React list re-render or reorder incorrectly?", answer: "Use a stable unique key per item instead of the array index so reconciliation tracks elements correctly." },

  { id: "as1", text: "How do you cancel an in-flight HTTP request in the browser?", answer: "Use an AbortController: pass its signal into fetch and call abort() to cancel the request." },
  { id: "as2", text: "How do you debounce a function in JavaScript?", answer: "Clear a pending timer on each call and set a new one, so it only runs after activity pauses." },
  { id: "as3", text: "How do you handle retries for a flaky network call?", answer: "Retry with exponential backoff and jitter, a capped attempt count, only for idempotent operations." },

  { id: "ds1", text: "What does eventual consistency mean in a distributed system?", answer: "Replicas may briefly disagree but converge to the same value once writes stop propagating." },
  { id: "ds2", text: "How do you stop duplicate processing when a client retries a request?", answer: "Require an idempotency key so the server records and de-duplicates repeated requests." },
  { id: "ds3", text: "What causes a deadlock between two database transactions?", answer: "Each holds a lock the other needs and both wait forever; a consistent lock ordering avoids it." },

  { id: "mx1", text: "Why is my Docker image so large?", answer: "Layers retain build artifacts; use a multi-stage build and a slim base image to shrink the final size." },
  { id: "mx2", text: "How do you fix a memory leak in a long-running Node process?", answer: "Take heap snapshots, find retained objects such as unbounded caches or stray listeners, and release them." },
  { id: "mx3", text: "How do you center a div with CSS?", answer: "Use flexbox on the parent: display:flex with justify-content:center and align-items:center." },
  { id: "mx4", text: "Why is the browser blocking my API call with a CORS error?", answer: "The server must send Access-Control-Allow-Origin (and preflight) headers permitting your origin." },
];

// Hard paraphrases; several intentionally land inside a cluster to test discrimination from siblings.
const QUERIES: Query[] = [
  { q: "the planner keeps reading the whole table instead of using an index", target: "pg1" },
  { q: "speed up a slow SELECT that filters on one column", target: "pg1" },
  { q: "my ORM fires one extra query for every row in a loop", target: "pg2" },
  { q: "the table keeps growing and queries degrade after lots of updates", target: "pg3" },
  { q: "we keep exhausting available database connections when traffic spikes", target: "pg4" },

  { q: "difference between proving who you are and granting permissions", target: "au1" },
  { q: "the right way to keep account credentials safe at rest", target: "au2" },
  { q: "what to do when the bearer token a client holds expires", target: "au3" },

  { q: "my component runs its render function twice while developing", target: "rx1" },
  { q: "the effect hook keeps firing over and over without stopping", target: "rx2" },
  { q: "rows jump around when I add items because I used the position as the identifier", target: "rx3" },

  { q: "stop a fetch that is already running", target: "as1" },
  { q: "only fire a handler after the user stops typing", target: "as2" },
  { q: "automatically re-attempt a request that intermittently fails", target: "as3" },

  { q: "replicas temporarily out of sync but agree later", target: "ds1" },
  { q: "avoid processing the same submission twice when the client resends it", target: "ds2" },
  { q: "two transactions stuck waiting on each other forever", target: "ds3" },

  { q: "shrink the size of my built container image", target: "mx1" },
  { q: "node service memory keeps creeping up over days of uptime", target: "mx2" },
  { q: "vertically and horizontally align a box in the middle of the page", target: "mx3" },
  { q: "the browser refuses my cross-origin request from the frontend", target: "mx4" },
];

const dot = (a: number[], b: number[]) => { let s = 0; const n = Math.min(a.length, b.length); for (let i = 0; i < n; i++) s += a[i]! * b[i]!; return s; };

async function run(model: string, usePrefix: boolean) {
  const extract = await pipeline("feature-extraction", model);
  const embed = async (t: string) => {
    const out = await extract(t && t.trim() ? t : " ", { pooling: "mean", normalize: true });
    return Array.from(out.data as Float32Array);
  };

  const docVecs = new Map<string, number[]>();
  for (const d of DOCS) docVecs.set(d.id, await embed(`${d.text} ${d.answer}`.trim()));

  let rrSum = 0, r1 = 0, r3 = 0, marginSum = 0, correctSum = 0, wrongSum = 0;
  const misses: string[] = [];
  for (const { q, target } of QUERIES) {
    const qv = await embed(usePrefix ? QUERY_PREFIX + q : q);
    const ranked = DOCS
      .map((d) => ({ id: d.id, sim: dot(qv, docVecs.get(d.id)!) }))
      .sort((a, b) => b.sim - a.sim);
    const rank = ranked.findIndex((r) => r.id === target) + 1;
    rrSum += 1 / rank;
    if (rank === 1) r1++; else misses.push(`${target}<-"${q}" (got ${ranked[0]!.id}@${ranked[0]!.sim.toFixed(2)}, target rank ${rank})`);
    if (rank <= 3) r3++;
    const correct = ranked.find((r) => r.id === target)!.sim;
    const bestWrong = ranked.find((r) => r.id !== target)!.sim;
    correctSum += correct; wrongSum += bestWrong; marginSum += correct - bestWrong;
  }
  const n = QUERIES.length;
  return { mrr: rrSum / n, r1: r1 / n, r3: r3 / n, correct: correctSum / n, bestWrong: wrongSum / n, margin: marginSum / n, misses };
}

const fmt = (x: number) => x.toFixed(3);
const configs = [
  { name: "A MiniLM-L6  raw query   (current) ", model: "Xenova/all-MiniLM-L6-v2", prefix: false },
  { name: "B bge-small  raw query             ", model: "Xenova/bge-small-en-v1.5", prefix: false },
  { name: "C bge-small  prefixed query (new)  ", model: "Xenova/bge-small-en-v1.5", prefix: true },
];

console.log(`corpus=${DOCS.length} docs in 6 confusable clusters  queries=${QUERIES.length} (hard paraphrases)\n`);
console.log("config                                 MRR    r@1    r@3   | cos:correct cos:bestWrong margin");
console.log("-".repeat(98));
for (const c of configs) {
  const m = await run(c.model, c.prefix);
  console.log(`${c.name}  ${fmt(m.mrr)}  ${fmt(m.r1)}  ${fmt(m.r3)}  |   ${fmt(m.correct)}      ${fmt(m.bestWrong)}     ${fmt(m.margin)}`);
  for (const miss of m.misses) console.log(`      miss: ${miss}`);
}
