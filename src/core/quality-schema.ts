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
  db.run("CREATE INDEX IF NOT EXISTS quality_runs_time ON quality_runs(started_ts,host,release_fingerprint)");
  db.run("CREATE INDEX IF NOT EXISTS quality_runs_session ON quality_runs(session_hash,turn_seq)");
  db.run("CREATE INDEX IF NOT EXISTS quality_events_run ON quality_events(run_id,ts,event_key)");
  db.run("CREATE INDEX IF NOT EXISTS quality_events_entity ON quality_events(entity_type,entity_hash,session_hash)");
  db.run("CREATE INDEX IF NOT EXISTS quality_events_kind ON quality_events(kind,ts)");
  const cutoff = Date.now() - Math.max(1, Number(process.env.CAIRN_USAGE_RETENTION_DAYS || "30")) * 86_400_000;
  db.query("DELETE FROM quality_events WHERE ts < ?").run(cutoff);
  db.query("DELETE FROM quality_runs WHERE started_ts < ?").run(cutoff);
  ready = true;
  return db;
}
