import { randomUUID } from "node:crypto";
import { embed, cosine } from "../core/embed";
import { skillVectors, putSkill, getSkill } from "./store";
import type { Skill } from "./types";

// Assigning a task to the right skill must be ACCURATE, because the skill id is the key that restores the
// right reviewer conversation. Pure semantic matching is not enough: measured MiniLM cosines overlap for
// close forms (a haiku vs a poem reach 0.696, inside the same-skill range), so a single threshold would
// merge distinct skills or split a repeat. So the PRIMARY key is a normalized label: same label, same
// skill, deterministically. Embedding is only a fallback for close rephrasings, gated ABOVE the measured
// cross-form overlap so distinct forms can never merge. Calibrated in scripts/skill-threshold.ts.
export const SKILL_THRESHOLD = Number(process.env.CAIRN_SKILL_THRESHOLD || "0.80"); // > measured 0.696 form overlap

const LEAD_VERB = /^(?:write|compose|draft|make|create|generate|build)\s+(?:a|an|the)\s+/;

/** Canonicalize a task label so phrasings of one task collapse: lowercase, drop a leading "write a"/
 *  "compose an", strip punctuation, collapse whitespace. "Write a Haiku!" and "haiku" both become "haiku". */
export function normalizeLabel(task: string): string {
  return task.toLowerCase().trim().replace(LEAD_VERB, "").replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
}

/** Match a task to an existing skill: exact normalized label first (deterministic restore key), then a
 *  high-threshold semantic fallback. Returns null to start a new skill. */
export async function matchSkill(task: string): Promise<{ id: string; score: number; exact: boolean } | null> {
  const norm = normalizeLabel(task);
  const skills = skillVectors();
  const exact = skills.find((s) => normalizeLabel(s.task) === norm);
  if (exact) return { id: exact.id, score: 1, exact: true };
  const q = await embed(task);
  let best: { id: string; score: number; exact: boolean } | null = null;
  for (const s of skills) {
    if (s.vec.length !== q.length) continue;
    const score = cosine(q, s.vec);
    if (!best || score > best.score) best = { id: s.id, score, exact: false };
  }
  return best && best.score >= SKILL_THRESHOLD ? best : null;
}

/** Categorize a task: return the matched skill, or create a new one. `now`/`newId` are injected so callers
 *  and tests stay deterministic. */
export async function categorize(task: string, now: number, newId: () => string = randomUUID): Promise<{ skill: Skill; created: boolean }> {
  const m = await matchSkill(task);
  if (m) return { skill: getSkill(m.id)!, created: false };
  const q = await embed(task);
  const skill: Skill = { id: newId(), task, masterPrompt: "", ts: now };
  putSkill(skill, q);
  return { skill, created: true };
}
