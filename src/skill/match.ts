import { randomUUID } from "node:crypto";
import { embed } from "../core/embed";
import { skillByLabel, insertSkillIfAbsent, normalizeLabel, setRichVector } from "./store";
import type { Skill } from "./types";

export { normalizeLabel };

// Rebuild the skill's rich retrieval vector from its label + master prompt, so retrieval (the injection path)
// matches the domain vocabulary the master introduces. Called when the reviewer assembles a master. The vector
// is used ONLY for advisory injection retrieval, never to decide a skill's identity. Best-effort.
export async function reindexSkill(id: string, task: string, master: string): Promise<void> {
  try { setRichVector(id, await embed(`${task}. ${master}`)); } catch { /* embedder down: keep the label vector */ }
}

// Routing is EXACT-LABEL ONLY. Which skill a finished run belongs to is decided by the classifier (an LLM that
// is shown the existing skills and reuses an existing label or coins a new one); the normalized label is then
// the sole, deterministic key. Cosine similarity NEVER decides skill identity here, because measured embeddings
// overlap badly for distinct tasks (haiku vs poem 0.696; "short story" vs "short story review" > 0.80), so any
// threshold either merges distinct skills or splits a repeat. Earlier this code had a 0.80 semantic-merge
// fallback and a 0.21 "purpose guard" that split reuses; both produced clobbers (a story review collapsed into
// the story skill) and were removed in favor of trusting the classifier. Semantic search remains only in
// retrieve.ts, where it is advisory (it picks which skill's steps to inject) and cannot corrupt a skill.

/** Categorize a task by its label: reuse the skill with that exact normalized label, or atomically create one.
 *  On a concurrent/retried create for the same label, both callers re-read the single winner by label.
 *  `now`/`newId` are injected so callers and tests stay deterministic. */
export async function categorize(task: string, now: number, newId: () => string = randomUUID): Promise<{ skill: Skill; created: boolean }> {
  const exact = skillByLabel(normalizeLabel(task));
  if (exact) return { skill: exact, created: false };
  let q: number[] = [];
  try { q = await embed(task); } catch { /* store without a vector; the exact-label key still works */ }
  const candidate: Skill = { id: newId(), task, masterPrompt: "", ts: now };
  insertSkillIfAbsent(candidate, q);
  const stored = skillByLabel(normalizeLabel(task)) ?? candidate; // the unique winner of any race
  return { skill: stored, created: stored.id === candidate.id };
}
