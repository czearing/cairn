import { createHash } from "node:crypto";
import { telemetryDatabase } from "./telemetry-schema";

/** Per-skill run outcomes, joined from the events a skill selection already emits.
 *
 *  This costs no tokens and needs no reviewer: `skill_selected` carries the run id, so every completed
 *  run can be attributed to the skills it used. It answers "is this skill present on runs that go well"
 *  rather than "is this skill good" — an association, not a grade. Completion sits near its ceiling on
 *  most skills, so the useful reading is a skill that falls clearly below the others, not a ranking of
 *  the ones at the top.
 *
 *  Runs that were abandoned or superseded are deliberately included. Restricting to status='completed'
 *  makes the completion rate a tautology — the `completed` column is 1 for exactly those runs — so every
 *  skill scores 100% and the column carries no information. The unfinished runs ARE the signal. */
export interface SkillOutcome {
  title: string;
  runs: number;
  completedRate: number;
  workflowRate: number;
  averageToolCalls: number;
  /** False when the sample is too small for the rates to mean anything. Report the count, not a rate. */
  sufficient: boolean;
}

/** Below this a single run moves a rate by tens of points, so the rate describes noise. */
export const MINIMUM_OUTCOME_RUNS = 5;

/** Matches the entity hash written by telemetry-record. */
const entityHash = (value: string): string =>
  value ? createHash("sha256").update(value).digest("hex").slice(0, 24) : "";

interface DistinctRunRow {
  hash: string;
  runId: string;
  completed: number;
  workflowPassed: number;
  toolCalls: number;
}

/**
 * Outcomes for each supplied skill over runs completed since `sinceTs`.
 *
 * Skills are matched on BOTH the hash of the title and the hash of the id. The selection event switched
 * from hashing the id to hashing the title partway through the retained window, so a title-only match
 * silently drops every earlier selection. Runs are de-duplicated across the two hashes, so a skill whose
 * history spans the switch is counted once per run rather than twice.
 */
export function skillOutcomes(
  sinceTs: number, skills: { id: string; title: string }[]
): SkillOutcome[] {
  const db = telemetryDatabase();
  if (!db || !skills.length) return [];
  let rows: DistinctRunRow[];
  try {
    rows = db.query(`SELECT DISTINCT e.entity_hash AS hash, r.run_id AS runId,
      r.completed AS completed, r.workflow_passed AS workflowPassed, r.tool_calls AS toolCalls
      FROM telemetry_events e JOIN telemetry_runs r USING(run_id)
      WHERE e.kind='skill_selected' AND e.ts>=? AND r.run_class='human'
        AND r.status IN ('completed','abandoned','superseded')`)
      .all(sinceTs) as DistinctRunRow[];
  } catch { return []; }

  const runsByHash = new Map<string, DistinctRunRow[]>();
  for (const row of rows) {
    const bucket = runsByHash.get(row.hash);
    if (bucket) bucket.push(row); else runsByHash.set(row.hash, [row]);
  }

  const outcomes: SkillOutcome[] = [];
  for (const skill of skills) {
    const byRun = new Map<string, DistinctRunRow>();
    for (const hash of new Set([entityHash(skill.title), entityHash(skill.id)])) {
      for (const row of runsByHash.get(hash) ?? []) byRun.set(row.runId, row);
    }
    const matched = [...byRun.values()];
    if (!matched.length) continue;
    const mean = (pick: (row: DistinctRunRow) => number): number =>
      matched.reduce((sum, row) => sum + pick(row), 0) / matched.length;
    outcomes.push({
      title: skill.title,
      runs: matched.length,
      completedRate: Math.round(mean((row) => row.completed) * 1000) / 10,
      workflowRate: Math.round(mean((row) => row.workflowPassed) * 1000) / 10,
      averageToolCalls: Math.round(mean((row) => row.toolCalls) * 10) / 10,
      sufficient: matched.length >= MINIMUM_OUTCOME_RUNS,
    });
  }
  return outcomes.sort((a, b) => b.runs - a.runs || a.title.localeCompare(b.title));
}
