import { usageTelemetryEnabled } from "./config";
import { localEventsDatabase } from "./host-events";

let ready = false;

export function qualityDatabase() {
  if (!usageTelemetryEnabled()) return null;
  const db = localEventsDatabase();
  if (ready) return db;
  db.run(`CREATE TABLE IF NOT EXISTS quality_runs (
    run_id TEXT PRIMARY KEY,
    host TEXT NOT NULL,
    session_hash TEXT NOT NULL,
    turn_seq INTEGER NOT NULL,
    release_fingerprint TEXT NOT NULL,
    version TEXT NOT NULL DEFAULT '',
    model TEXT NOT NULL DEFAULT '',
    prompt_hash TEXT NOT NULL DEFAULT '',
    catalog_version TEXT NOT NULL DEFAULT '',
    started_ts INTEGER NOT NULL,
    ended_ts INTEGER NOT NULL DEFAULT 0,
    injected_tokens INTEGER NOT NULL DEFAULT 0,
    completed INTEGER NOT NULL DEFAULT 0,
    workflow_passed INTEGER NOT NULL DEFAULT 0,
    skill_used INTEGER NOT NULL DEFAULT 0,
    brain_used INTEGER NOT NULL DEFAULT 0,
    stop_nudges INTEGER NOT NULL DEFAULT 0,
    tool_calls INTEGER NOT NULL DEFAULT 0,
    tool_failures INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'active'
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS quality_events (
    event_key TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    host TEXT NOT NULL,
    session_hash TEXT NOT NULL,
    turn_seq INTEGER NOT NULL,
    ts INTEGER NOT NULL,
    kind TEXT NOT NULL,
    tool_name TEXT NOT NULL DEFAULT '',
    entity_type TEXT NOT NULL DEFAULT '',
    entity_hash TEXT NOT NULL DEFAULT '',
    success INTEGER NOT NULL DEFAULT 1,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    duration_ms INTEGER NOT NULL DEFAULT 0,
    item_count INTEGER NOT NULL DEFAULT 0,
    value INTEGER NOT NULL DEFAULT 0
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS prompt_evaluations (
    evaluation_id TEXT PRIMARY KEY,
    baseline_prompt_hash TEXT NOT NULL,
    candidate_prompt_hash TEXT NOT NULL,
    quality_definition_hash TEXT NOT NULL,
    accepted INTEGER NOT NULL,
    token_reduction REAL NOT NULL,
    safe_token_reduction REAL,
    quality_improvements INTEGER NOT NULL,
    quality_checks INTEGER NOT NULL,
    compared_runs INTEGER NOT NULL,
    created_ts INTEGER NOT NULL
  )`);
  const promptEvaluationColumns = db.query("PRAGMA table_info(prompt_evaluations)")
    .all() as { name: string }[];
  if (promptEvaluationColumns.some((column) => column.name === "target_set_hash")) {
    const hasDefinition = promptEvaluationColumns.some(
      (column) => column.name === "quality_definition_hash");
    db.run("DROP TABLE IF EXISTS prompt_evaluations_next");
    db.run(`CREATE TABLE prompt_evaluations_next (
      evaluation_id TEXT PRIMARY KEY,
      baseline_prompt_hash TEXT NOT NULL,
      candidate_prompt_hash TEXT NOT NULL,
      quality_definition_hash TEXT NOT NULL,
      accepted INTEGER NOT NULL,
      token_reduction REAL NOT NULL,
      safe_token_reduction REAL,
      quality_improvements INTEGER NOT NULL,
      quality_checks INTEGER NOT NULL,
      compared_runs INTEGER NOT NULL,
      created_ts INTEGER NOT NULL
    )`);
    db.run(`INSERT INTO prompt_evaluations_next
      SELECT evaluation_id,baseline_prompt_hash,candidate_prompt_hash,
        ${hasDefinition
          ? "CASE WHEN quality_definition_hash='' THEN target_set_hash ELSE quality_definition_hash END"
          : "target_set_hash"},
        accepted,token_reduction,safe_token_reduction,quality_improvements,
        quality_checks,compared_runs,created_ts
      FROM prompt_evaluations`);
    db.run("DROP TABLE prompt_evaluations");
    db.run("ALTER TABLE prompt_evaluations_next RENAME TO prompt_evaluations");
  }
  db.run("CREATE INDEX IF NOT EXISTS quality_runs_time ON quality_runs(started_ts,host,release_fingerprint)");
  db.run("CREATE INDEX IF NOT EXISTS quality_runs_session ON quality_runs(session_hash,turn_seq)");
  db.run("CREATE INDEX IF NOT EXISTS quality_events_run ON quality_events(run_id,ts,event_key)");
  db.run("CREATE INDEX IF NOT EXISTS quality_events_entity ON quality_events(entity_type,entity_hash,session_hash)");
  db.run("CREATE INDEX IF NOT EXISTS quality_events_kind ON quality_events(kind,ts)");
  db.run("CREATE INDEX IF NOT EXISTS prompt_evaluations_candidate ON prompt_evaluations(candidate_prompt_hash,created_ts)");
  const cutoff = Date.now() - Math.max(1, Number(process.env.CAIRN_USAGE_RETENTION_DAYS || "30")) * 86_400_000;
  db.query("DELETE FROM quality_events WHERE ts < ?").run(cutoff);
  db.query("DELETE FROM quality_runs WHERE started_ts < ?").run(cutoff);
  db.query("DELETE FROM prompt_evaluations WHERE created_ts < ?").run(cutoff);
  ready = true;
  return db;
}
