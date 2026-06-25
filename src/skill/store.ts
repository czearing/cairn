import { db } from "../core/db";
import { encodeVector, decodeVector } from "../core/vector";
import { embedModel } from "../core/embed";
import type { Skill, SkillRun } from "./types";

// Skill store. Sidecar tables in the SAME cairn db, reusing core's connection, embedding, and vector
// packing, so there is no second database or duplicated embedding stack. A skill is a master prompt for a
// task family plus its top-N graded runs (what the reviewer references). `label_norm` is the canonical
// label with a UNIQUE index, so the same task can never create two skills even under a retry or a race
// (INSERT OR IGNORE makes creation idempotent). Neurons/sync are untouched.

const LEAD_VERB = /^(?:write|compose|draft|make|create|generate|build)\s+(?:a|an|the)\s+/;
/** Canonicalize a task label so phrasings of one task collapse: lowercase, drop a leading "write a"/
 *  "compose an", strip punctuation, collapse whitespace. "Write a Haiku!" and "haiku" both become "haiku". */
export function normalizeLabel(task: string): string {
  return task.toLowerCase().trim().replace(LEAD_VERB, "").replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
}

let ready = false;
function ensure(): void {
  if (ready) return;
  ready = true; // set first: on a READ-ONLY connection (the hook) the DDL below throws, but reads against
  //              already-created tables must still proceed, so we never retry the failed DDL.
  try {
    db().run("CREATE TABLE IF NOT EXISTS skills (id TEXT PRIMARY KEY, task TEXT NOT NULL, label_norm TEXT NOT NULL DEFAULT '', master_prompt TEXT NOT NULL DEFAULT '', embedding BLOB, rich BLOB, embedding_model TEXT, session_started INTEGER NOT NULL DEFAULT 0, ts INTEGER NOT NULL)");
    db().run("CREATE TABLE IF NOT EXISTS skill_runs (id INTEGER PRIMARY KEY AUTOINCREMENT, skill_id TEXT NOT NULL, recipe TEXT NOT NULL, quality REAL NOT NULL, review TEXT NOT NULL DEFAULT '', ts INTEGER NOT NULL)");
    db().run("CREATE INDEX IF NOT EXISTS skill_runs_skill_q ON skill_runs (skill_id, quality)");
    const cols = db().query("PRAGMA table_info(skills)").all() as { name: string }[]; // backfill older skills tables
    if (!cols.some((c) => c.name === "session_started")) db().run("ALTER TABLE skills ADD COLUMN session_started INTEGER NOT NULL DEFAULT 0");
    if (!cols.some((c) => c.name === "rich")) db().run("ALTER TABLE skills ADD COLUMN rich BLOB"); // domain-vocab vector
    if (!cols.some((c) => c.name === "label_norm")) {
      db().run("ALTER TABLE skills ADD COLUMN label_norm TEXT NOT NULL DEFAULT ''");
      for (const r of db().query("SELECT id, task FROM skills WHERE label_norm = ''").all() as { id: string; task: string }[]) db().run("UPDATE skills SET label_norm = ? WHERE id = ?", normalizeLabel(r.task), r.id);
    }
    db().run("CREATE UNIQUE INDEX IF NOT EXISTS skills_label ON skills (label_norm)");
  } catch { /* read-only connection or legacy duplicate labels: reads still work against existing tables */ }
}

const SKILL_COLS = "id, task, label_norm, master_prompt, embedding, embedding_model, session_started, ts";
const SKILL_VALS = "?, ?, ?, ?, ?, ?, ?, ?";
const skillRow = (s: Skill, vec: number[]) => [s.id, s.task, normalizeLabel(s.task), s.masterPrompt, encodeVector(vec), embedModel(), 0, s.ts] as const;

/** Insert (or replace) a skill with its task embedding. Used for explicit puts; creation uses the atomic
 *  insertSkillIfAbsent below. */
export function putSkill(s: Skill, vec: number[]): Skill {
  ensure();
  db().run(`INSERT OR REPLACE INTO skills (${SKILL_COLS}) VALUES (${SKILL_VALS})`, ...skillRow(s, vec));
  return s;
}

/** Create a skill only if its normalized label is free (atomic, idempotent). A concurrent or retried
 *  create for the same label is a no-op; the caller re-reads by label to get the single winner. */
export function insertSkillIfAbsent(s: Skill, vec: number[]): void {
  ensure();
  db().run(`INSERT OR IGNORE INTO skills (${SKILL_COLS}) VALUES (${SKILL_VALS})`, ...skillRow(s, vec));
}

const SELECT_SKILL = "SELECT id, task, master_prompt AS masterPrompt, ts FROM skills";
export function getSkill(id: string): Skill | null {
  ensure();
  try { return (db().query(`${SELECT_SKILL} WHERE id = ?`).get(id) as Skill | undefined) ?? null; } catch { return null; }
}

/** The skill owning a normalized label, or null. The exact-match restore key, indexed and unique. */
export function skillByLabel(labelNorm: string): Skill | null {
  ensure();
  return (db().query(`${SELECT_SKILL} WHERE label_norm = ?`).get(labelNorm) as Skill | undefined) ?? null;
}

/** Replace a skill's master prompt (what the reviewer assembles and the doer reuses). */
export function setMasterPrompt(id: string, masterPrompt: string): void {
  ensure();
  db().run("UPDATE skills SET master_prompt = ? WHERE id = ?", masterPrompt, id);
}

/** Every skill's label (the `task` field), for biasing the labeler toward reuse. */
export function skillLabels(): string[] {
  ensure();
  return (db().query("SELECT task FROM skills").all() as { task: string }[]).map((r) => r.task);
}

/** Every skill's id, task, label vector, and rich (label+master) vector. Assignment uses the clean label
 *  vector; retrieval takes the max over both so domain vocabulary (e.g. "pull request") still matches.
 *  Empty on a read-only/missing table. */
export function skillVectors(): { id: string; task: string; vec: number[]; rich: number[] }[] {
  ensure();
  try {
    return (db().query("SELECT id, task, embedding, rich FROM skills").all() as { id: string; task: string; embedding: unknown; rich: unknown }[])
      .map((r) => ({ id: r.id, task: r.task, vec: decodeVector(r.embedding) ?? [], rich: decodeVector(r.rich) ?? [] }));
  } catch { return []; }
}

/** Store the rich (label + master prompt) retrieval vector, set when the master prompt is assembled. */
export function setRichVector(id: string, vec: number[]): void {
  ensure();
  try { db().run("UPDATE skills SET rich = ? WHERE id = ?", encodeVector(vec), id); } catch { /* read-only */ }
}

/** Has the reviewer started a persistent session for this skill? Decides --session-id vs --resume. */
export function hasSession(id: string): boolean {
  ensure();
  return ((db().query("SELECT session_started FROM skills WHERE id = ?").get(id) as { session_started?: number } | undefined)?.session_started ?? 0) === 1;
}

/** Mark the skill's reviewer session as started, so later reviews resume it. */
export function markSession(id: string): void {
  ensure();
  db().run("UPDATE skills SET session_started = 1 WHERE id = ?", id);
}

/** Record a run under a skill, then prune to the top `keep` by quality (the reviewer's reference set). */
export function addRun(run: SkillRun, keep = 10): void {
  ensure();
  db().run("INSERT INTO skill_runs (skill_id, recipe, quality, review, ts) VALUES (?, ?, ?, ?, ?)", run.skillId, run.recipe, run.quality, run.review, run.ts);
  db().run("DELETE FROM skill_runs WHERE skill_id = ? AND id NOT IN (SELECT id FROM skill_runs WHERE skill_id = ? ORDER BY quality DESC, ts DESC LIMIT ?)", run.skillId, run.skillId, keep);
}

/** The top `n` runs for a skill by quality (the reviewer references these to assemble the master prompt). */
export function topRuns(skillId: string, n = 10): SkillRun[] {
  ensure();
  return db().query("SELECT id, skill_id AS skillId, recipe, quality, review, ts FROM skill_runs WHERE skill_id = ? ORDER BY quality DESC, ts DESC LIMIT ?").all(skillId, n) as SkillRun[];
}

/** Every skill with its runs in chronological order, for the viewer (what is in the store + how it has
 *  changed over time). Read-only-tolerant. */
export function listSkills(): (Skill & { runs: SkillRun[] })[] {
  ensure();
  try {
    const skills = db().query("SELECT id, task, master_prompt AS masterPrompt, ts FROM skills ORDER BY ts DESC").all() as Skill[];
    return skills.map((s) => ({ ...s, runs: db().query("SELECT id, skill_id AS skillId, recipe, quality, review, ts FROM skill_runs WHERE skill_id = ? ORDER BY ts ASC").all(s.id) as SkillRun[] }));
  } catch { return []; }
}
