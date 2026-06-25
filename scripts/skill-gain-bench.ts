// Does injecting a skill's curated steps actually improve output quality? A/B: generate the SAME task
// COLD (bare request) vs WARM (curated master prompt injected), then grade each with a BLIND grader (it
// sees only the output). The gain = warm mean - cold mean. Run: bun scripts/skill-gain-bench.ts
import { runClaude } from "../src/skill/claude";

const TASK = "write a haiku about the first snow of winter";
const MASTER = `Curated steps for haiku, the most effective approach learned from prior runs:
- Strict 5-7-5 syllables; count them.
- One concrete seasonal image (a kigo), never an abstraction.
- A real turn (kireji): two images that pivot, the last line reframes.
- Cut every cliche and filler ("so cold", "very", "beautiful"); each word must earn its place.`;
const RUBRIC = `Grade this haiku 0.00-1.00 on: correct 5-7-5, concrete seasonal imagery, a genuine turn, and absence of cliche/filler. Reply ONLY {"score":x,"reason":"<=8 words"}.`;

const gen = async (master?: string) =>
  (await runClaude(master ? `${master}\n\nNow ${TASK}. Output only the haiku.` : `${TASK}. Output only the haiku.`)).text.trim();
async function grade(haiku: string): Promise<number | null> {
  const m = (await runClaude(`${RUBRIC}\n\nHAIKU:\n${haiku}`)).text.match(/\{[\s\S]*\}/);
  try { const s = JSON.parse(m![0]).score; return typeof s === "number" ? s : null; } catch { return null; }
}
const mean = (a: number[]) => a.reduce((s, x) => s + x, 0) / a.length;

const N = 3;
const cold: number[] = [], warm: number[] = [];
console.log("generating + grading (blind) cold vs warm...\n");
for (let i = 0; i < N; i++) { const h = await gen(); const s = await grade(h); if (s != null) cold.push(s); console.log(`cold ${i + 1}: ${s}`); }
for (let i = 0; i < N; i++) { const h = await gen(MASTER); const s = await grade(h); if (s != null) warm.push(s); console.log(`warm ${i + 1}: ${s}`); }
console.log(`\ncold mean ${mean(cold).toFixed(2)}  (${JSON.stringify(cold)})`);
console.log(`warm mean ${mean(warm).toFixed(2)}  (${JSON.stringify(warm)})`);
console.log(`GAIN from injecting curated steps: ${(mean(warm) - mean(cold)).toFixed(2)}`);
