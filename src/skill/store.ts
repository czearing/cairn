import { db } from "../core/db";
import { encodeVector, decodeVector } from "../core/vector";
import { embedModel } from "../core/embed";
import type { Skill, SkillRun } from "./types";

// Skill store. Sidecar tables in the SAME cairn db, reusing core's connection, embedding, and vector
// packing, so there is no second database or duplicated embedding stack. A skill is a master prompt for a
// task family plus its top-N graded runs (what the reviewer references). The task text is embedded so a
// new task can be matched to an existing skill (see match.ts). Neurons/sync are untouched.

let ready = false;
function ensure(): void {
  if (ready) return;
  db().run("CREATE TABLE IF NOT EXISTS skills (id TEXT PRIMARY KEY, task TEXT NOT NULL, master_prompt TEXT NOT NULL DEFAULT '', embedding BLOB, embedding_model TEXT, ts INTEGER NOT NULL)");
  db().run("CREATE TABLE IF NOT EXISTS skill_runs (id INTEGER PRIMARY KEY AUTOINCREMENT, skill_id TEXT NOT NULL, recipe TEXT NOT NULL, quality REAL NOT NULL, review TEXT NOT NULL DEFAULT '', ts INTEGER NOT NULL)");
  db().run("CREATE INDEX IF NOT EXISTS skill_runs_skill_q ON skill_runs (skill_id, quality)");
  ready = true;
}

/** Insert (or replace) a skill with its task embedding. */
export function putSkill(s: Skill, vec: number[]): Skill {
  ensure();
  db().run("INSERT OR REPLACE INTO skills (id, task, master_prompt, embedding, embedding_model, ts) VALUES (?, ?, ?, ?, ?, ?)", s.id, s.task, s.masterPrompt, encodeVector(vec), embedModel(), s.ts);
  return s;
}

export function getSkill(id: string): Skill | null {
  ensure();
  const r = db().query("SELECT id, task, master_prompt AS masterPrompt, ts FROM skills WHERE id = ?").get(id) as Skill | undefined;
  return r ?? null;
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

/** Every skill's id, task, and decoded vector, for semantic matching. */
export function skillVectors(): { id: string; task: string; vec: number[] }[] {
  ensure();
  return (db().query("SELECT id, task, embedding FROM skills").all() as { id: string; task: string; embedding: unknown }[])
    .map((r) => ({ id: r.id, task: r.task, vec: decodeVector(r.embedding) ?? [] }));
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
