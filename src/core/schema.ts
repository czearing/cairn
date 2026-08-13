import type { Stmt } from "./db";
import { HOST_EVENTS_SCHEMA, hostEventsPruneSql } from "./host-events.schema";

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
  ...HOST_EVENTS_SCHEMA,
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
  `CREATE TRIGGER IF NOT EXISTS neurons_search_ai AFTER INSERT ON neurons BEGIN
    UPDATE engine_meta SET value = value + 1 WHERE key = 'search_seq';
  END`,
  `CREATE TRIGGER IF NOT EXISTS neurons_search_au
    AFTER UPDATE OF text,answer,citation,embedding,embedding_model ON neurons BEGIN
    UPDATE engine_meta SET value = value + 1 WHERE key = 'search_seq';
  END`,
  `CREATE TRIGGER IF NOT EXISTS neurons_search_ad AFTER DELETE ON neurons BEGIN
    UPDATE engine_meta SET value = value + 1 WHERE key = 'search_seq';
  END`,
  `CREATE TRIGGER IF NOT EXISTS neuron_edges_search_ai AFTER INSERT ON neuron_edges BEGIN
    UPDATE engine_meta SET value = value + 1 WHERE key = 'search_seq';
  END`,
  `CREATE TRIGGER IF NOT EXISTS neuron_edges_search_au AFTER UPDATE ON neuron_edges BEGIN
    UPDATE engine_meta SET value = value + 1 WHERE key = 'search_seq';
  END`,
  `CREATE TRIGGER IF NOT EXISTS neuron_edges_search_ad AFTER DELETE ON neuron_edges BEGIN
    UPDATE engine_meta SET value = value + 1 WHERE key = 'search_seq';
  END`,
];

export function ensureEngineSchema(query: Query, exec: Exec): void {
  for (const sql of ENGINE_TABLES) exec(sql);
  exec("INSERT INTO engine_meta(key,value) VALUES ('vector_seq',0) ON CONFLICT(key) DO NOTHING");
  exec("INSERT INTO engine_meta(key,value) VALUES ('search_seq',0) ON CONFLICT(key) DO NOTHING");
  exec(`INSERT OR IGNORE INTO neuron_edges(source_id,target_id,relation_type,provenance,position)
    SELECT n.id, CAST(j.value AS TEXT), 'related', 'legacy-json', CAST(j.key AS INTEGER)
    FROM neurons n, json_each(CASE WHEN json_valid(n.edges) THEN n.edges ELSE '[]' END) j
    WHERE j.type = 'text' AND CAST(j.value AS TEXT) <> n.id`);
  for (const sql of TRIGGERS) exec(sql);
  // Writer-only, so a hook fire never pays for it: the hooks' own host_events connection applies the
  // DDL alone. The long-lived server and every CLI open pass through here, which is enough to keep the
  // append-only event log bounded.
  exec(hostEventsPruneSql());
  query("PRAGMA optimize").get();
}
