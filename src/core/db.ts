import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "./config";

let _db: Database | null = null;

// One shared connection, opened lazily. Schema is created on first open.
export function db(): Database {
  if (_db) return _db;
  mkdirSync(dirname(config.dbPath), { recursive: true });
  const d = new Database(config.dbPath);
  d.run("PRAGMA journal_mode = WAL");
  d.run(
    `CREATE TABLE IF NOT EXISTS neurons (
       id        TEXT PRIMARY KEY,
       text      TEXT NOT NULL,
       answer    TEXT NOT NULL DEFAULT '',
       citation  TEXT NOT NULL DEFAULT '',
       edges     TEXT NOT NULL DEFAULT '[]',
       embedding TEXT
     )`
  );
  // migrate brains created before the citation column existed
  const cols = d.query("PRAGMA table_info(neurons)").all() as { name: string }[];
  if (!cols.some((c) => c.name === "citation")) {
    d.run("ALTER TABLE neurons ADD COLUMN citation TEXT NOT NULL DEFAULT ''");
  }
  _db = d;
  return d;
}
