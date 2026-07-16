import { embed, cosine } from "../core/embed";
import { skillVectors } from "./store";

// Rank EVERY skill by semantic similarity to a query (no threshold), most-relevant first. For the UI search
// box: the user types a query and sees all skills reordered by relevance, not a hard-filtered subset. Empty on
// an empty store or an embedder failure.
export async function rankSkillIds(query: string): Promise<{ id: string; score: number }[]> {
  if (!query.trim()) return [];
  const vecs = skillVectors();
  if (!vecs.length) return [];
  let q: number[];
  try { q = await embed(query); } catch { return []; }
  return vecs.map((s) => {
    let score = -1;
    if (s.vec.length === q.length) score = cosine(q, s.vec);
    if (s.rich.length === q.length) score = Math.max(score, cosine(q, s.rich));
    return { id: s.id, score };
  }).sort((a, b) => b.score - a.score);
}
