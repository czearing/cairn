import { embed, cosine } from "../core/embed";
import { skillVectors, getSkill } from "./store";
import type { Skill } from "./types";

// Retrieval side of the loop: on a new turn, find the matching skill and inject its curated master prompt.
// This is the INSTANT path (one embed + a cosine scan, no LLM), separate from the accurate labeler used
// for assignment in the async learn phase. A slightly-off injection is low-harm (the agent can ignore it),
// so retrieval trades a little accuracy for speed. Calibrated (skill-retrieve-bench): real matches score
// >= 0.32 (6/6 correct), unrelated requests <= 0.27, so 0.30 separates them cleanly with no false inject.
export const RETRIEVE_THRESHOLD = Number(process.env.CAIRN_RETRIEVE_THRESHOLD || "0.30");

// Condense a turn's user messages into ONE query, so a 10-message turn does ONE search, not ten. The most
// recent messages carry the current ask; a little prior context disambiguates. Bounded so a long turn
// cannot blow up the embed input.
export function condenseMessages(messages: string[]): string {
  const cleaned = messages.map((m) => m.trim()).filter(Boolean);
  return cleaned.slice(-3).join(" ").slice(0, 2000);
}

// Instant semantic retrieval: embed the condensed query, return the best skill above threshold (or null).
export async function retrieveSkill(query: string): Promise<{ skill: Skill; score: number } | null> {
  if (!query.trim()) return null;
  let q: number[];
  try { q = await embed(query); } catch { return null; } // embedder down: no injection, never crash
  let best: { id: string; score: number } | null = null;
  for (const s of skillVectors()) {
    if (s.vec.length !== q.length) continue;
    const score = cosine(q, s.vec);
    if (!best || score > best.score) best = { id: s.id, score };
  }
  if (!best || best.score < RETRIEVE_THRESHOLD) return null;
  const skill = getSkill(best.id);
  return skill ? { skill, score: best.score } : null;
}

// Format a skill's master prompt as the injected guidance shown to the agent.
export function injectionText(skill: Skill): string {
  if (!skill.masterPrompt.trim()) return "";
  return `Curated steps for "${skill.task}", the most effective approach learned from prior successful runs. Follow them to accomplish the task:\n\n${skill.masterPrompt}`;
}

// End to end: condense the turn's messages, retrieve the best skill, return its injection text (or null).
export async function retrieveInjection(messages: string[]): Promise<string | null> {
  const m = await retrieveSkill(condenseMessages(messages));
  return m ? injectionText(m.skill) || null : null;
}
