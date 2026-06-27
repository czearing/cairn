// 1-agent vs 2-agent: is the loop's SEPARATE reviewer worth its extra call, or can one self-critiquing
// agent match it for half the cost? Bare prompt ("write a haiku", no topic) so fresh-subject invention
// counts. Per trial: produce a haiku both ways, then a single neutral judge picks the better (pairwise,
// position-flipped to cancel order bias). Real cost from `claude -p --output-format json` (total_cost_usd
// + tokens). Run: bun scripts/skill-agents-bench.ts
import { spawn } from "node:child_process";
import { cairnMcpConfigPath } from "../src/skill/cairn-mcp";

const BIN = process.platform === "win32" ? "claude.exe" : "claude";
const T = Number(process.env.BENCH_TRIALS || "5");
const MCP = cairnMcpConfigPath(); // every agent here is cairn-connected so it can recall craft from the brain

// One headless call, JSON output, cairn-connected (brain_search). Returns the text plus measured cost/tokens/latency.
function run(prompt: string): Promise<{ text: string; cost: number; inTok: number; outTok: number; ms: number }> {
  return new Promise((resolve) => {
    let out = "";
    const c = spawn(BIN, ["-p", "--output-format", "json", "--setting-sources", "project", "--mcp-config", MCP, "--allowedTools", "mcp__cairn__brain_search"], { stdio: ["pipe", "pipe", "ignore"] });
    c.stdout.on("data", (d) => (out += String(d)));
    c.on("error", () => resolve({ text: "", cost: 0, inTok: 0, outTok: 0, ms: 0 }));
    c.on("close", () => {
      try { const j = JSON.parse(out); resolve({ text: String(j.result ?? "").trim(), cost: j.total_cost_usd ?? 0, inTok: j.usage?.input_tokens ?? 0, outTok: j.usage?.output_tokens ?? 0, ms: j.duration_ms ?? 0 }); }
      catch { resolve({ text: "", cost: 0, inTok: 0, outTok: 0, ms: 0 }); }
    });
    c.stdin.end(prompt);
  });
}

const ONE = "Write a haiku. Then critique your own draft for cliche, vague abstraction, and forced syllables, and rewrite a stronger final version. Output only the final haiku, nothing else.";
const WRITE = "Write a haiku. Output only the haiku, nothing else.";
const REVIEW = (h: string) => `Here is a haiku draft. Critique it for cliche, vague abstraction, and forced syllables, then output only an improved final haiku, nothing else.\n\n${h}`;
const JUDGE = (a: string, b: string) => `Two haiku, A and B. Choose the better one on imagery, freshness, and craft. Output only the single letter A or B.\n\nA:\n${a}\n\nB:\n${b}`;

let oneWins = 0, twoWins = 0, oneCost = 0, twoCost = 0, judgeCost = 0, oneMs = 0, twoMs = 0, oneOut = 0, twoOut = 0;
for (let t = 0; t < T; t++) {
  const one = await run(ONE);                 // 1-agent: self-critique in a single call
  const draft = await run(WRITE);             // 2-agent: writer ...
  const two = await run(REVIEW(draft.text));  // ... + independent reviewer
  const flip = t % 2 === 0;                    // cancel position bias
  const j = await run(JUDGE(flip ? one.text : two.text, flip ? two.text : one.text));
  const pickedA = j.text.trim().toUpperCase().startsWith("A");
  const oneWon = pickedA === flip;
  oneWon ? oneWins++ : twoWins++;
  oneCost += one.cost; twoCost += draft.cost + two.cost; judgeCost += j.cost;
  oneMs += one.ms; twoMs += draft.ms + two.ms; oneOut += one.outTok; twoOut += draft.outTok + two.outTok;
  console.log(`trial ${t + 1}: winner ${oneWon ? "1-agent" : "2-agent"} | 1-agent $${one.cost.toFixed(4)} (${one.outTok} out-tok) | 2-agent $${(draft.cost + two.cost).toFixed(4)} (${draft.outTok + two.outTok} out-tok)`);
}

console.log(`\n=== ${T} trials, bare "write a haiku" ===`);
console.log(`quality (neutral judge): 1-agent ${oneWins}/${T} wins | 2-agent ${twoWins}/${T} wins`);
console.log(`avg cost/haiku: 1-agent $${(oneCost / T).toFixed(4)} | 2-agent $${(twoCost / T).toFixed(4)} | ratio 2:1 = ${(twoCost / Math.max(oneCost, 1e-9)).toFixed(2)}x`);
console.log(`avg latency:    1-agent ${(oneMs / T / 1000).toFixed(1)}s | 2-agent ${(twoMs / T / 1000).toFixed(1)}s`);
console.log(`avg out-tokens: 1-agent ${Math.round(oneOut / T)} | 2-agent ${Math.round(twoOut / T)}`);
console.log(`judge overhead: $${(judgeCost / T).toFixed(4)}/trial (only needed for this comparison, not in production)`);
