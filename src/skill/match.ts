import { randomUUID } from "node:crypto";
import { embed, cosine } from "../core/embed";
import { skillVectors, getSkill, skillByLabel, insertSkillIfAbsent, normalizeLabel, setRichVector, skillIdentityVector, setIdentityVector, setBaseLabel, variantSkills } from "./store";
import type { Skill } from "./types";

export { normalizeLabel };

// Rebuild the skill's rich retrieval vector from its label + master prompt, so retrieval matches the
// domain vocabulary the master introduces. Called when the reviewer assembles a master. Best-effort.
export async function reindexSkill(id: string, task: string, master: string): Promise<void> {
  try { setRichVector(id, await embed(`${task}. ${master}`)); } catch { /* embedder down: keep the label vector */ }
}

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

// Purpose guard. A run's label can collide with an existing skill that is actually a DIFFERENT task (the
// learner reused "pr monitor" for an audio A/B). Reusing it would overwrite that skill's master, and since
// retrieval matches on the master, the wrong skill then pulls every later similar task in: a clobber loop.
// The guard compares this run's REQUEST vector to the skill's FROZEN identity (the request that first formed
// it); if it is too far, the run is routed to a same-base variant whose identity matches (so off-purpose runs
// of one family converge), or a fresh variant is minted, leaving the original skill untouched.
//
// Signal = the REQUEST, not the master: masters share too much instructional boilerplate ("1. Read... no em
// dashes... record to the brain") to separate (measured: master cross-cosines reach 0.90). Request cosines
// separate cleanly (skill-purpose-threshold.ts: within-task floor 0.24, cross-task mostly < 0.18, the
// audio-vs-pr clobber 0.198). The threshold sits in that gap, leaning LOOSE (below the within-task floor) so
// a real same-task request is NEVER wrongly forked; the cost is that borderline different tasks slip through
// to be caught later by the labeler prompt. Override with CAIRN_PURPOSE_THRESHOLD.
export const PURPOSE_THRESHOLD = Number(process.env.CAIRN_PURPOSE_THRESHOLD || "0.21");

/** The guard/identity signal for a run: its request embedded. Frozen as a skill's identity on first write
 *  and compared against on every later reuse. */
export async function embedRequest(request: string): Promise<number[]> {
  return embed(request);
}

/** Resolve which skill a run (with its already-embedded content vector) should write to, guarding a reuse
 *  against the matched skill's frozen purpose. Returns the original skill when the purpose matches, a same-
 *  base variant when one already fits, or a freshly minted variant otherwise. */
export async function resolveForRun(label: string, contentVec: number[], now: number): Promise<{ skill: Skill; created: boolean; split: boolean }> {
  const { skill, created } = await categorize(label, now);
  if (created || !contentVec.length) return { skill, created, split: false }; // brand-new skill: nothing to clobber
  const idVec = skillIdentityVector(skill.id);
  if (!idVec.length) return { skill, created: false, split: false };          // no identity yet (legacy): allow; caller freezes it
  if (cosine(contentVec, idVec) >= PURPOSE_THRESHOLD) return { skill, created: false, split: false }; // same purpose: reuse
  for (const v of variantSkills(label)) {                                     // converge onto an existing matching variant
    if (v.id === skill.id) continue;
    const vv = skillIdentityVector(v.id);
    if (vv.length && cosine(contentVec, vv) >= PURPOSE_THRESHOLD) { const got = getSkill(v.id); if (got) return { skill: got, created: false, split: true }; }
  }
  return { skill: await mintVariant(label, contentVec, now), created: true, split: true };
}

/** Mint a new "<label> (N)" skill (first free N from 2) with its identity frozen to this run's content, so a
 *  different-purpose run that collided with an existing label gets its own skill instead of clobbering one. */
async function mintVariant(label: string, contentVec: number[], now: number): Promise<Skill> {
  let n = 2, newLabel = `${label} (${n})`;
  while (skillByLabel(normalizeLabel(newLabel))) { n++; newLabel = `${label} (${n})`; }
  let q: number[] = [];
  try { q = await embed(newLabel); } catch { /* exact-label key still works */ }
  const candidate: Skill = { id: randomUUID(), task: newLabel, masterPrompt: "", ts: now };
  insertSkillIfAbsent(candidate, q);
  const stored = skillByLabel(normalizeLabel(newLabel)) ?? candidate;
  // Only stamp identity/base_label when WE created this skill. If the normalized label collided with a
  // pre-existing skill (insert was a no-op), never touch its frozen identity.
  if (stored.id === candidate.id) { setBaseLabel(stored.id, normalizeLabel(label)); setIdentityVector(stored.id, contentVec, newLabel); }
  return stored;
}

/** Freeze a skill's identity vector on its first master write (no-op once set, so it never drifts). */
export function freezeIdentityIfNew(skillId: string, contentVec: number[], text: string): void {
  if (!contentVec.length || skillIdentityVector(skillId).length) return;
  setIdentityVector(skillId, contentVec, text);
}
