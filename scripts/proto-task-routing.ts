// Why route by a DISCRETE task type, not text similarity. "poem" and "haiku" are close in embedding
// space, so a similarity router treats a new haiku request as a continuation of the poem and merges
// them into one confused thread. A discrete task-type key keeps them apart. Measured below.
let seed = 5; const rng = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };

// message: a new task ("poem"/"haiku") or feedback on whatever is current.
type Msg = { kind: "task" | "fb"; type?: "poem" | "haiku" };
// simulated similarity of a message to the CURRENT task bucket:
//   feedback refines current => high (~0.88); a different poetry task => still high (~0.72, the trap);
//   the same task type => high.
function simToCurrent(m: Msg, current: string | null): number {
  if (m.kind === "fb") return 0.88 + (rng() - 0.5) * 0.06;
  if (m.type === current) return 0.9 + (rng() - 0.5) * 0.05;
  return 0.72 + (rng() - 0.5) * 0.06; // poem vs haiku: close enough to fool a similarity threshold
}
const FUZZY_THRESH = 0.6; // continue current if sim above this
// fuzzy router: continue current when similar, else start a new bucket named by the message's own type.
function fuzzyRoute(m: Msg, current: string | null): string {
  if (current && simToCurrent(m, current) > FUZZY_THRESH) return current; // <-- merges haiku into poem
  return m.type ?? current ?? "unknown";
}
// discrete router: a message that NAMES a different task type opens that bucket; feedback continues current.
function discreteRoute(m: Msg, current: string | null, extractOk = true): string {
  if (m.kind === "task" && m.type && extractOk && m.type !== current) return m.type;
  return current ?? m.type ?? "unknown";
}

// stream: write a poem, two critiques, then write a haiku, two critiques. Ground-truth bucket per msg.
const stream: { m: Msg; truth: "poem" | "haiku" }[] = [
  { m: { kind: "task", type: "poem" }, truth: "poem" },
  { m: { kind: "fb" }, truth: "poem" }, { m: { kind: "fb" }, truth: "poem" },
  { m: { kind: "task", type: "haiku" }, truth: "haiku" },
  { m: { kind: "fb" }, truth: "haiku" }, { m: { kind: "fb" }, truth: "haiku" },
];
function misroute(router: (m: Msg, c: string | null, ok?: boolean) => string, extractOk = 1, F = 5000) {
  let wrong = 0, total = 0, merged = 0;
  for (let f = 0; f < F; f++) {
    let cur: string | null = null;
    for (const { m, truth } of stream) {
      const ok = rng() < extractOk;
      const bucket = router(m, cur, ok);
      cur = bucket;
      total++; if (bucket !== truth) wrong++;
      if (truth === "haiku" && bucket === "poem") merged++; // the specific failure: haiku merged into poem
    }
  }
  return { misroute: wrong / total, haikuMergedIntoPoem: merged / (F * 3) };
}
console.log("stream: [write poem, critique, critique, write haiku, critique, critique]\n");
const fz = misroute((m, c) => fuzzyRoute(m, c));
console.log(`fuzzy-similarity router:   misroute ${(fz.misroute*100).toFixed(1)}%   haiku-content-merged-into-poem ${(fz.haikuMergedIntoPoem*100).toFixed(1)}%`);
const dс = misroute((m, c, ok) => discreteRoute(m, c, ok), 1.0);
console.log(`discrete task-type key:    misroute ${(dс.misroute*100).toFixed(1)}%   haiku-content-merged-into-poem ${(dс.haikuMergedIntoPoem*100).toFixed(1)}%`);
const dn = misroute((m, c, ok) => discreteRoute(m, c, ok), 0.9);
console.log(`discrete (10% extract miss): misroute ${(dn.misroute*100).toFixed(1)}%   haiku-merged ${(dn.haikuMergedIntoPoem*100).toFixed(1)}%`);
