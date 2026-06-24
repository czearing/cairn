import { randomUUID } from "node:crypto";
import { embed, cosine } from "../core/embed";
import { skillVectors, getSkill, skillByLabel, insertSkillIfAbsent, normalizeLabel } from "./store";
import type { Skill } from "./types";

export { normalizeLabel };

// Assigning a task to the right skill must be ACCURATE, because the skill id is the key that restores the
// right reviewer conversation. Pure semantic matching is not enough: measured MiniLM cosines overlap for
// close forms (a haiku vs a poem reach 0.696, inside the same-skill range), so a single threshold would
// merge distinct skills or split a repeat. So the PRIMARY key is the normalized label (an indexed, unique
// exact match). Embedding is only a fallback for close rephrasings, gated ABOVE the measured cross-form
// overlap so distinct forms can never merge. Calibrated in scripts/skill-threshold.ts.
export const SKILL_THRESHOLD = Number(process.env.CAIRN_SKILL_THRESHOLD || "0.80"); // > measured 0.696 form overlap

/** Match a task to an existing skill: exact normalized-label first (deterministic restore key), then a
 *  high-threshold semantic fallback. Returns null to start a new skill. */
export async function matchSkill(task: string): Promise<{ id: string; score: number; exact: boolean } | null> {
  const exact = skillByLabel(normalizeLabel(task));
  if (exact) return { id: exact.id, score: 1, exact: true };
  let q: number[];
  try { q = await embed(task); } catch { return null; } // embedder unavailable: exact-match only, never crash
  let best: { id: string; score: number; exact: boolean } | null = null;
  for (const s of skillVectors()) {
    if (s.vec.length !== q.length) continue;
    const score = cosine(q, s.vec);
    if (!best || score > best.score) best = { id: s.id, score, exact: false };
  }
  return best && best.score >= SKILL_THRESHOLD ? best : null;
}

/** Categorize a task: return the matched skill, or atomically create one. On a concurrent/retried create
 *  for the same label, both callers re-read the single winner by label. `now`/`newId` are injected so
 *  callers and tests stay deterministic. */
export async function categorize(task: string, now: number, newId: () => string = randomUUID): Promise<{ skill: Skill; created: boolean }> {
  const m = await matchSkill(task);
  if (m) return { skill: getSkill(m.id)!, created: false };
  let q: number[] = [];
  try { q = await embed(task); } catch { /* store without a vector; the exact-label key still works */ }
  const candidate: Skill = { id: newId(), task, masterPrompt: "", ts: now };
  insertSkillIfAbsent(candidate, q);
  const stored = skillByLabel(normalizeLabel(task)) ?? candidate; // the unique winner of any race
  return { skill: stored, created: stored.id === candidate.id };
}
