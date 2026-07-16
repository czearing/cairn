import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "../core/config";

let connection: Database | null = null;

function database(): Database {
  if (connection) return connection;
  mkdirSync(dirname(config.dbPath), { recursive: true });
  const d = new Database(config.dbPath);
  d.run("PRAGMA journal_mode = WAL");
  d.run("PRAGMA busy_timeout = 5000");
  d.run(`CREATE TABLE IF NOT EXISTS missed_skill_reviews (
    scope TEXT NOT NULL,
    turn_seq INTEGER NOT NULL,
    skill_id TEXT NOT NULL,
    transcript_path TEXT NOT NULL DEFAULT '',
    created_ts INTEGER NOT NULL,
    PRIMARY KEY(scope, turn_seq, skill_id)
  )`);
  d.run(`CREATE INDEX IF NOT EXISTS missed_skill_reviews_skill
    ON missed_skill_reviews(skill_id, created_ts)`);
  connection = d;
  return d;
}

export function recordMissedReviews(
  scope: string,
  turnSeq: number,
  skillIds: string[],
  transcriptPath: string,
  now = Date.now()
): number {
  const ids = [...new Set(skillIds)].filter((id) => id && !id.startsWith("__"));
  const insert = database().query(`INSERT INTO missed_skill_reviews(
    scope,turn_seq,skill_id,transcript_path,created_ts
  ) VALUES (?,?,?,?,?) ON CONFLICT(scope,turn_seq,skill_id) DO NOTHING`);
  let created = 0;
  for (const id of ids) created += insert.run(scope, turnSeq, id, transcriptPath, now).changes;
  return created;
}
