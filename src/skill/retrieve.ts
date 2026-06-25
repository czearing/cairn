import { embed, cosine } from "../core/embed";
import { skillVectors, getSkill } from "./store";
import type { Skill } from "./types";

// Retrieval side of the loop: on a new turn, find the matching skill and inject its curated master prompt.
// This is the INSTANT path (one embed + a cosine scan, no LLM), separate from the accurate labeler used
// for assignment in the async learn phase. A slightly-off injection is low-harm (the agent can ignore it),
// so retrieval trades a little accuracy for speed. Calibrated (skill-retrieve-bench): real matches score
// >= 0.32 (6/6 correct), unrelated requests <= 0.27, so 0.30 separates them cleanly with no false inject.
export const RETRIEVE_THRESHOLD = Number(process.env.CAIRN_RETRIEVE_THRESHOLD || "0.30");
// How many related skills to draw from. The threshold already excludes unrelated families (a short story
// draws "poem" but never "git setup"; measured), so >1 lets a request pull its whole relevant cluster
// (a poem draws poem + haiku) without ever pulling an irrelevant skill.
export const RETRIEVE_K = Number(process.env.CAIRN_RETRIEVE_K || "2");

// Condense a turn's user messages into ONE query, so a 10-message turn does ONE search, not ten. The most
// recent messages carry the current ask; a little prior context disambiguates. Bounded so a long turn
// cannot blow up the embed input.
export function condenseMessages(messages: string[]): string {
  const cleaned = messages.map((m) => m.trim()).filter(Boolean);
  return cleaned.slice(-3).join(" ").slice(0, 2000);
}

// Instant semantic retrieval: embed the condensed query once, return the skills above threshold (top k by
// score). Empty on no match or an embedder failure (never crashes).
export async function retrieveSkills(query: string, k = RETRIEVE_K): Promise<{ skill: Skill; score: number }[]> {
  if (!query.trim()) return [];
  let q: number[];
  try { q = await embed(query); } catch { return []; }
  const scored: { id: string; score: number }[] = [];
  for (const s of skillVectors()) {
    if (s.vec.length !== q.length) continue;
    const score = cosine(q, s.vec);
    if (score >= RETRIEVE_THRESHOLD) scored.push({ id: s.id, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, k).map((x) => ({ skill: getSkill(x.id), score: x.score })).filter((x): x is { skill: Skill; score: number } => x.skill != null);
}

// The single best match (or null), for callers that want just the top skill.
export async function retrieveSkill(query: string): Promise<{ skill: Skill; score: number } | null> {
  return (await retrieveSkills(query, 1))[0] ?? null;
}

// Format the matched skills' master prompts as the injected guidance shown to the agent. One skill reads
// as "the" approach; several read as a related cluster to draw on.
export function injectionText(skills: Skill[]): string {
  const withMaster = skills.filter((s) => s.masterPrompt.trim());
  if (!withMaster.length) return "";
  if (withMaster.length === 1)
    return `Curated steps for "${withMaster[0]!.task}", the most effective approach learned from prior successful runs. Follow them to accomplish the task:\n\n${withMaster[0]!.masterPrompt}`;
  const blocks = withMaster.map((s) => `## ${s.task}\n${s.masterPrompt}`).join("\n\n");
  return `Curated steps from related skills (${withMaster.map((s) => s.task).join(", ")}), learned from prior successful runs. Draw on what fits the task:\n\n${blocks}`;
}

// End to end: condense the turn's messages, retrieve the relevant skills, return the injection text (or null).
export async function retrieveInjection(messages: string[]): Promise<string | null> {
  const skills = (await retrieveSkills(condenseMessages(messages))).map((x) => x.skill);
  return injectionText(skills) || null;
}
