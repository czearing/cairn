import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { config } from "./config";

let _db: Database | null = null;

// Safety net (learned the hard way): tests wipe the table in beforeEach. They are isolated onto a
// temp DB by tests/setup.ts — but ONLY if bunfig.toml's preload loads, which requires `bun test`
// to run from the repo root. Run it from elsewhere and the preload is skipped, so the real brain
// would be the target. This guard refuses to open the default ~/.cairn/cairn.db during ANY test
// run regardless of cwd, turning a silent data-loss into a loud, harmless failure.
function assertNotRealBrainInTests(dbPath: string): void {
  const underTest = process.argv.some((a) => a === "test" || a.endsWith(".test.ts"));
  if (!underTest || process.env.CAIRN_ALLOW_REAL_DB) return;
  const realBrain = resolve(join(homedir(), ".cairn", "cairn.db"));
  if (resolve(dbPath) === realBrain) {
    throw new Error(
      "Refusing to open the real brain (~/.cairn/cairn.db) during a test run. Run `bun test` from " +
        "the repo root so tests/setup.ts isolates onto a temp DB, or set CAIRN_DB_PATH yourself. " +
        "(Override with CAIRN_ALLOW_REAL_DB=1 only if you truly mean it.)"
    );
  }
}

// One shared connection, opened lazily. Schema is created on first open.
export function db(): Database {
  if (_db) return _db;
  assertNotRealBrainInTests(config.dbPath);
  mkdirSync(dirname(config.dbPath), { recursive: true });
  const d = new Database(config.dbPath);
  d.run("PRAGMA journal_mode = WAL");
  d.run(
    `CREATE TABLE IF NOT EXISTS neurons (
       id              TEXT PRIMARY KEY,
       text            TEXT NOT NULL,
       answer          TEXT NOT NULL DEFAULT '',
       citation        TEXT NOT NULL DEFAULT '',
       edges           TEXT NOT NULL DEFAULT '[]',
       embedding       TEXT,
       embedding_model TEXT
     )`
  );
  // migrate brains created before a column existed
  const cols = d.query("PRAGMA table_info(neurons)").all() as { name: string }[];
  if (!cols.some((c) => c.name === "citation")) {
    d.run("ALTER TABLE neurons ADD COLUMN citation TEXT NOT NULL DEFAULT ''");
  }
  // embedding_model records which model produced each vector, so search can detect a model change
  // and re-embed old vectors that are no longer comparable. NULL on legacy rows triggers a re-embed.
  if (!cols.some((c) => c.name === "embedding_model")) {
    d.run("ALTER TABLE neurons ADD COLUMN embedding_model TEXT");
  }
  _db = d;
  return d;
}
