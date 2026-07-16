import type { Stmt } from "./db";

type Query = (sql: string) => Stmt;
type Exec = (sql: string) => void;

const ENGINE_TABLES = [
  `CREATE TABLE IF NOT EXISTS engine_meta (
    key TEXT PRIMARY KEY,
    value INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS neuron_edges (
    source_id TEXT NOT NULL,
    target_id TEXT NOT NULL,
    relation_type TEXT NOT NULL DEFAULT 'related',
    provenance TEXT NOT NULL DEFAULT 'agent',
    position INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (source_id, target_id, relation_type)
  )`,
  `CREATE INDEX IF NOT EXISTS neuron_edges_target
    ON neuron_edges(target_id, relation_type, source_id)`,
  `CREATE INDEX IF NOT EXISTS neuron_edges_source_position
    ON neuron_edges(source_id, relation_type, position, target_id)`,
  `CREATE TABLE IF NOT EXISTS neuron_vector_index (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    model TEXT NOT NULL,
    dimensions INTEGER NOT NULL,
    table_name TEXT NOT NULL,
    source_seq INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS host_events (
    event_key TEXT PRIMARY KEY,
    host TEXT NOT NULL,
    hook_type TEXT NOT NULL,
    session_id TEXT NOT NULL DEFAULT '',
    turn_id TEXT NOT NULL DEFAULT '',
    agent_id TEXT NOT NULL DEFAULT '',
    tool_call_id TEXT NOT NULL DEFAULT '',
    tool_name TEXT NOT NULL DEFAULT '',
    event_timestamp TEXT NOT NULL DEFAULT '',
    raw_json TEXT NOT NULL,
    recorded_ts INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS host_events_session_recorded
    ON host_events(host, session_id, recorded_ts, event_key)`,
  `CREATE INDEX IF NOT EXISTS host_events_tool_call
    ON host_events(host, tool_call_id, hook_type)`,
  `CREATE INDEX IF NOT EXISTS host_events_agent
    ON host_events(host, session_id, agent_id, recorded_ts)`,
];

const TRIGGERS = [
  `CREATE TRIGGER IF NOT EXISTS neurons_vector_ai AFTER INSERT ON neurons BEGIN
    UPDATE engine_meta SET value = value + 1 WHERE key = 'vector_seq';
  END`,
  `CREATE TRIGGER IF NOT EXISTS neurons_vector_au
    AFTER UPDATE OF embedding, embedding_model ON neurons BEGIN
    UPDATE engine_meta SET value = value + 1 WHERE key = 'vector_seq';
  END`,
  `CREATE TRIGGER IF NOT EXISTS neurons_vector_ad AFTER DELETE ON neurons BEGIN
    UPDATE engine_meta SET value = value + 1 WHERE key = 'vector_seq';
    DELETE FROM neuron_edges WHERE source_id = OLD.id OR target_id = OLD.id;
  END`,
];

export function ensureEngineSchema(query: Query, exec: Exec): void {
  for (const sql of ENGINE_TABLES) exec(sql);
  exec("INSERT INTO engine_meta(key,value) VALUES ('vector_seq',0) ON CONFLICT(key) DO NOTHING");
  exec(`INSERT OR IGNORE INTO neuron_edges(source_id,target_id,relation_type,provenance,position)
    SELECT n.id, CAST(j.value AS TEXT), 'related', 'legacy-json', CAST(j.key AS INTEGER)
    FROM neurons n, json_each(CASE WHEN json_valid(n.edges) THEN n.edges ELSE '[]' END) j
    WHERE j.type = 'text' AND CAST(j.value AS TEXT) <> n.id`);
  for (const sql of TRIGGERS) exec(sql);
  query("PRAGMA optimize").get();
}
