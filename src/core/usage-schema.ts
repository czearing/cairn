import { localEventsDatabase } from "./host-events";
import { releaseVersion, telemetryRunClass } from "./release";

let ready = false;

const addColumn = (
  db: ReturnType<typeof localEventsDatabase>,
  columns: Set<string>,
  name: string,
  definition: string,
) => {
  if (!columns.has(name)) db.run(`ALTER TABLE usage_events ADD COLUMN ${name} ${definition}`);
};

export function usageDatabase() {
  const db = localEventsDatabase();
  if (ready) return db;
  db.run(`CREATE TABLE IF NOT EXISTS usage_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_key TEXT UNIQUE,
    ts INTEGER NOT NULL,
    event_kind TEXT NOT NULL,
    source TEXT NOT NULL,
    host TEXT NOT NULL DEFAULT '',
    session_hash TEXT NOT NULL DEFAULT '',
    turn_seq INTEGER NOT NULL DEFAULT 0,
    tool_name TEXT NOT NULL DEFAULT '',
    input_chars INTEGER NOT NULL DEFAULT 0,
    output_chars INTEGER NOT NULL DEFAULT 0,
    context_chars INTEGER NOT NULL DEFAULT 0,
    estimated_tokens INTEGER NOT NULL DEFAULT 0,
    duration_ms INTEGER NOT NULL DEFAULT 0,
    item_count INTEGER NOT NULL DEFAULT 0,
    success INTEGER NOT NULL DEFAULT 1,
    release_fingerprint TEXT NOT NULL DEFAULT '',
    version TEXT NOT NULL DEFAULT '',
    run_class TEXT NOT NULL DEFAULT 'human'
  )`);
  const columns = new Set(
    (db.query("PRAGMA table_info(usage_events)").all() as { name: string }[])
      .map((column) => column.name),
  );
  addColumn(db, columns, "release_fingerprint", "TEXT NOT NULL DEFAULT ''");
  addColumn(db, columns, "version", "TEXT NOT NULL DEFAULT ''");
  addColumn(db, columns, "run_class", "TEXT NOT NULL DEFAULT 'human'");
  db.query("UPDATE usage_events SET version=? WHERE version=''").run(releaseVersion);
  db.query("UPDATE usage_events SET run_class=? WHERE run_class=''").run(telemetryRunClass());
  const hasQualityRuns = db.query(`SELECT 1 AS ok FROM sqlite_master
    WHERE type='table' AND name='quality_runs'`).get();
  if (hasQualityRuns) {
    const qualityColumns = new Set(
      (db.query("PRAGMA table_info(quality_runs)").all() as { name: string }[])
        .map((column) => column.name),
    );
    const runClass = qualityColumns.has("run_class") ? "q.run_class" : "'human'";
    db.run(`UPDATE usage_events SET
      release_fingerprint=COALESCE((SELECT q.release_fingerprint FROM quality_runs q
        WHERE q.host=usage_events.host AND q.session_hash=usage_events.session_hash
          AND q.turn_seq=usage_events.turn_seq LIMIT 1),release_fingerprint),
      version=COALESCE((SELECT q.version FROM quality_runs q
        WHERE q.host=usage_events.host AND q.session_hash=usage_events.session_hash
          AND q.turn_seq=usage_events.turn_seq LIMIT 1),version),
      run_class=COALESCE((SELECT ${runClass} FROM quality_runs q
        WHERE q.host=usage_events.host AND q.session_hash=usage_events.session_hash
          AND q.turn_seq=usage_events.turn_seq LIMIT 1),run_class)
      WHERE session_hash!=''`);
  }
  db.run("CREATE INDEX IF NOT EXISTS usage_events_ts ON usage_events(ts)");
  db.run("CREATE INDEX IF NOT EXISTS usage_events_source ON usage_events(event_kind,source,ts)");
  db.run("CREATE INDEX IF NOT EXISTS usage_events_session ON usage_events(session_hash,turn_seq,ts)");
  db.run("CREATE INDEX IF NOT EXISTS usage_events_release ON usage_events(run_class,release_fingerprint,ts)");
  const retentionDays = Math.max(1, Number(process.env.CAIRN_USAGE_RETENTION_DAYS || "30"));
  db.query("DELETE FROM usage_events WHERE ts < ?").run(Date.now() - retentionDays * 86_400_000);
  ready = true;
  return db;
}
