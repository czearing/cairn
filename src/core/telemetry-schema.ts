import { usageTelemetryEnabled } from "./config";
import { localEventsDatabase } from "./host-events";
import { releaseVersion, telemetryRunClass } from "./release";

let ready = false;
type Db = ReturnType<typeof localEventsDatabase>;

const hasTable = (db: Db, name: string): boolean =>
  Boolean(db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
const columns = (db: Db, table: string): Set<string> =>
  new Set((db.query(`PRAGMA table_info(${table})`).all() as { name: string }[])
    .map((column) => column.name));
const literal = (value: string): string => `'${value.replaceAll("'", "''")}'`;

function migrate(db: Db): void {
  if (hasTable(db, "quality_runs")) {
    const names = columns(db, "quality_runs");
    const version = names.has("version") ? "version" : literal(releaseVersion);
    const runClass = names.has("run_class") ? "run_class" : "'human'";
    db.run(`INSERT OR IGNORE INTO telemetry_runs(
      run_id,host,session_hash,turn_seq,release_fingerprint,version,model,
      prompt_hash,catalog_version,run_class,started_ts,ended_ts,injected_tokens,
      completed,workflow_passed,skill_used,brain_used,stop_nudges,tool_calls,
      tool_failures,status
    )
    SELECT run_id,host,session_hash,turn_seq,release_fingerprint,${version},model,
      prompt_hash,catalog_version,${runClass},started_ts,ended_ts,injected_tokens,
      completed,workflow_passed,skill_used,brain_used,stop_nudges,tool_calls,
      tool_failures,status FROM quality_runs`);
  }
  if (hasTable(db, "quality_events")) {
    db.run(`INSERT OR IGNORE INTO telemetry_events(
      event_key,run_id,host,session_hash,turn_seq,ts,kind,source,tool_name,
      entity_type,entity_hash,success,input_tokens,output_tokens,estimated_tokens,
      duration_ms,item_count,value,release_fingerprint,version,run_class
    )
    SELECT 'quality:'||e.event_key,e.run_id,e.host,e.session_hash,e.turn_seq,e.ts,
      e.kind,'host',e.tool_name,e.entity_type,e.entity_hash,e.success,
      e.input_tokens,e.output_tokens,e.input_tokens+e.output_tokens,
      e.duration_ms,e.item_count,e.value,r.release_fingerprint,r.version,r.run_class
    FROM quality_events e JOIN telemetry_runs r USING(run_id)`);
  }
  if (hasTable(db, "usage_events")) {
    const names = columns(db, "usage_events");
    const release = names.has("release_fingerprint") ? "u.release_fingerprint" : "''";
    const version = names.has("version") ? "u.version" : literal(releaseVersion);
    const runClass = names.has("run_class") ? "u.run_class" : "'human'";
    db.run(`INSERT OR IGNORE INTO telemetry_events(
      event_key,run_id,host,session_hash,turn_seq,ts,kind,source,tool_name,
      success,input_chars,output_chars,context_chars,estimated_tokens,
      duration_ms,item_count,release_fingerprint,version,run_class
    )
    SELECT 'usage:'||COALESCE(event_key,printf('%lld',id)),
      COALESCE((SELECT run_id FROM telemetry_runs r
        WHERE r.host=u.host AND r.session_hash=u.session_hash AND r.turn_seq=u.turn_seq LIMIT 1),''),
      host,session_hash,turn_seq,ts,
      CASE WHEN event_kind='tool' THEN 'tool_transport' ELSE event_kind END,
      source,tool_name,success,input_chars,output_chars,context_chars,estimated_tokens,
      duration_ms,item_count,
      COALESCE((SELECT release_fingerprint FROM telemetry_runs r
        WHERE r.host=u.host AND r.session_hash=u.session_hash AND r.turn_seq=u.turn_seq LIMIT 1),${release}),
      COALESCE((SELECT version FROM telemetry_runs r
        WHERE r.host=u.host AND r.session_hash=u.session_hash AND r.turn_seq=u.turn_seq LIMIT 1),${version}),
      COALESCE((SELECT run_class FROM telemetry_runs r
        WHERE r.host=u.host AND r.session_hash=u.session_hash AND r.turn_seq=u.turn_seq LIMIT 1),${runClass})
    FROM usage_events u`);
  }
  if (hasTable(db, "prompt_evaluations")) {
    const names = columns(db, "prompt_evaluations");
    const definition = names.has("quality_definition_hash")
      ? "quality_definition_hash"
      : "target_set_hash";
    db.run(`INSERT OR IGNORE INTO telemetry_evaluations
      SELECT evaluation_id,baseline_prompt_hash,candidate_prompt_hash,${definition},
        accepted,token_reduction,safe_token_reduction,quality_improvements,
        quality_checks,compared_runs,created_ts FROM prompt_evaluations`);
  }
  for (const table of ["usage_events", "quality_events", "quality_runs", "prompt_evaluations"]) {
    if (hasTable(db, table)) db.run(`DROP TABLE ${table}`);
  }
}

export function telemetryDatabase(): Db | null {
  if (!usageTelemetryEnabled()) return null;
  const db = localEventsDatabase();
  if (ready) return db;
  db.run(`CREATE TABLE IF NOT EXISTS telemetry_runs (
      run_id TEXT PRIMARY KEY,host TEXT NOT NULL,session_hash TEXT NOT NULL,
      turn_seq INTEGER NOT NULL,release_fingerprint TEXT NOT NULL,
      version TEXT NOT NULL DEFAULT '',model TEXT NOT NULL DEFAULT '',
      prompt_hash TEXT NOT NULL DEFAULT '',catalog_version TEXT NOT NULL DEFAULT '',
      run_class TEXT NOT NULL DEFAULT 'human',started_ts INTEGER NOT NULL,
      ended_ts INTEGER NOT NULL DEFAULT 0,injected_tokens INTEGER NOT NULL DEFAULT 0,
      completed INTEGER NOT NULL DEFAULT 0,workflow_passed INTEGER NOT NULL DEFAULT 0,
      skill_used INTEGER NOT NULL DEFAULT 0,brain_used INTEGER NOT NULL DEFAULT 0,
      stop_nudges INTEGER NOT NULL DEFAULT 0,tool_calls INTEGER NOT NULL DEFAULT 0,
      tool_failures INTEGER NOT NULL DEFAULT 0,status TEXT NOT NULL DEFAULT 'active'
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS telemetry_events (
      event_key TEXT PRIMARY KEY,run_id TEXT NOT NULL DEFAULT '',host TEXT NOT NULL,
      session_hash TEXT NOT NULL DEFAULT '',turn_seq INTEGER NOT NULL DEFAULT 0,
      ts INTEGER NOT NULL,kind TEXT NOT NULL,source TEXT NOT NULL DEFAULT '',
      tool_name TEXT NOT NULL DEFAULT '',entity_type TEXT NOT NULL DEFAULT '',
      entity_hash TEXT NOT NULL DEFAULT '',success INTEGER NOT NULL DEFAULT 1,
      input_tokens INTEGER NOT NULL DEFAULT 0,output_tokens INTEGER NOT NULL DEFAULT 0,
      context_tokens INTEGER NOT NULL DEFAULT 0,input_chars INTEGER NOT NULL DEFAULT 0,
      output_chars INTEGER NOT NULL DEFAULT 0,context_chars INTEGER NOT NULL DEFAULT 0,
      estimated_tokens INTEGER NOT NULL DEFAULT 0,duration_ms INTEGER NOT NULL DEFAULT 0,
      item_count INTEGER NOT NULL DEFAULT 0,value INTEGER NOT NULL DEFAULT 0,
      release_fingerprint TEXT NOT NULL DEFAULT '',version TEXT NOT NULL DEFAULT '',
      run_class TEXT NOT NULL DEFAULT 'human'
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS telemetry_evaluations (
      evaluation_id TEXT PRIMARY KEY,baseline_prompt_hash TEXT NOT NULL,
      candidate_prompt_hash TEXT NOT NULL,quality_definition_hash TEXT NOT NULL,
      accepted INTEGER NOT NULL,token_reduction REAL NOT NULL,
      safe_token_reduction REAL,quality_improvements INTEGER NOT NULL,
      quality_checks INTEGER NOT NULL,compared_runs INTEGER NOT NULL,
      created_ts INTEGER NOT NULL
    )`);
    migrate(db);
    db.run(`UPDATE telemetry_events SET version=${literal(releaseVersion)} WHERE version=''`);
  db.query("UPDATE telemetry_events SET run_class=? WHERE run_class=''")
    .run(telemetryRunClass());
  db.run(`UPDATE telemetry_events SET
    run_id=COALESCE((SELECT r.run_id FROM telemetry_runs r
      WHERE r.host=telemetry_events.host AND r.session_hash=telemetry_events.session_hash
        AND r.turn_seq=telemetry_events.turn_seq LIMIT 1),run_id),
    release_fingerprint=COALESCE((SELECT r.release_fingerprint FROM telemetry_runs r
      WHERE r.host=telemetry_events.host AND r.session_hash=telemetry_events.session_hash
        AND r.turn_seq=telemetry_events.turn_seq LIMIT 1),release_fingerprint),
    version=COALESCE((SELECT r.version FROM telemetry_runs r
      WHERE r.host=telemetry_events.host AND r.session_hash=telemetry_events.session_hash
        AND r.turn_seq=telemetry_events.turn_seq LIMIT 1),version),
    run_class=COALESCE((SELECT r.run_class FROM telemetry_runs r
      WHERE r.host=telemetry_events.host AND r.session_hash=telemetry_events.session_hash
        AND r.turn_seq=telemetry_events.turn_seq LIMIT 1),run_class)
    WHERE session_hash!=''`);
  db.run(`UPDATE telemetry_runs SET run_class='benchmark' WHERE run_id IN (
    SELECT DISTINCT run_id FROM telemetry_events WHERE tool_name LIKE '%benchmark_submit'
  )`);
  db.run(`UPDATE telemetry_events SET run_class='benchmark' WHERE run_id IN (
    SELECT run_id FROM telemetry_runs WHERE run_class='benchmark'
  )`);
    db.run(`CREATE INDEX IF NOT EXISTS telemetry_runs_release
      ON telemetry_runs(run_class,release_fingerprint,started_ts)`);
    db.run("CREATE INDEX IF NOT EXISTS telemetry_runs_session ON telemetry_runs(session_hash,turn_seq)");
    db.run("CREATE INDEX IF NOT EXISTS telemetry_events_run ON telemetry_events(run_id,kind,ts)");
    db.run(`CREATE INDEX IF NOT EXISTS telemetry_events_release
      ON telemetry_events(run_class,release_fingerprint,ts)`);
    db.run("CREATE INDEX IF NOT EXISTS telemetry_events_entity ON telemetry_events(entity_type,entity_hash,session_hash)");
  db.run("CREATE INDEX IF NOT EXISTS telemetry_evaluations_candidate ON telemetry_evaluations(candidate_prompt_hash,created_ts)");
  const cutoff = Date.now()
    - Math.max(1, Number(process.env.CAIRN_USAGE_RETENTION_DAYS || "30")) * 86_400_000;
  db.query("DELETE FROM telemetry_events WHERE ts<?").run(cutoff);
  db.query("DELETE FROM telemetry_runs WHERE started_ts<?").run(cutoff);
  db.query("DELETE FROM telemetry_evaluations WHERE created_ts<?").run(cutoff);
  ready = true;
  return db;
}
