import { create, mutate, link } from "./src/core/neurons";
const ROOT = "96c5dddf-a5d1-4a1c-bb7c-a3f09d140aea";
const n = await create("What is the final --ai-repair chain and where is its output for the Tropical Piano AI track?", [ROOT]);
await mutate(n.id, {
  answer: "Chain order: de-click (cut ~52 micro-glitches) -> transient shaper (re-sharpen attacks) -> de-shimmer (5-8 kHz) -> SBR (replicate air above ~14.5 kHz) -> warmth (saturation) -> -0.3 dBFS peak-safety. Output written to C:\Users\calebzearing\Downloads\Tropical Piano.cleaned.wav (32-bit float WAV). Remaining un-fixed artifact = RVQ codec grain (needs ML).",
  citation: "refmaster screech --ai-repair, commit cd8da50 2026-06-22",
});
link(n.id, ROOT);
console.log("recorded:", n.id);
