import { Database as BunDatabase } from "bun:sqlite";
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { config } from "./config";

// The brain runs on one of two interchangeable SQLite backends, chosen at open time:
//   • bun:sqlite (default) — a local file, zero config.
//   • libSQL embedded replica — a local file that write-throughs to a Turso cloud primary and
//     pulls remote changes, so the same brain syncs across devices. Active only when
//     CAIRN_LIBSQL_URL + CAIRN_LIBSQL_TOKEN are set.
// Both expose the exact same prepared-statement surface (all/get/run), so the rest of core (neurons,
// search) is backend-agnostic and the test suite — which never sets the libSQL vars — is unchanged.

/** The slice of a prepared statement the brain actually uses. Satisfied by both bun:sqlite's and
 * libSQL's (better-sqlite3-compatible) Statement. */
export interface Stmt {
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown;
  run(...params: unknown[]): { changes: number; lastInsertRowid?: number | bigint };
}

/** The brain handle the rest of core talks to: prepare a statement, or execute one directly. */
export interface Db {
  query(sql: string): Stmt;
  /** Execute a statement for its side effect (DDL, or a parameterless write like a test's DELETE). */
  run(sql: string, ...params: unknown[]): void;
}

let _db: Db | null = null;
let _sync: (() => void) | null = null;

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

// Create the neurons table and backfill columns added in later versions. Backend-neutral: it talks
// only through the `query`/`exec` callbacks so it serves both bun:sqlite and libSQL. Reads the schema
// first and only writes DDL when something is missing, so the cloud primary isn't churned on every
// open.
function ensureSchema(query: (sql: string) => Stmt, exec: (sql: string) => void, wal: boolean): void {
  if (wal) exec("PRAGMA journal_mode = WAL"); // replicas manage journaling themselves; skip it there
  const cols = query("PRAGMA table_info(neurons)").all() as { name: string }[];
  if (cols.length === 0) {
    exec(
      `CREATE TABLE neurons (
         id              TEXT PRIMARY KEY,
         text            TEXT NOT NULL,
         answer          TEXT NOT NULL DEFAULT '',
         citation        TEXT NOT NULL DEFAULT '',
         edges           TEXT NOT NULL DEFAULT '[]',
         embedding       TEXT,
         embedding_model TEXT
       )`
    );
    return;
  }
  // citation backs the no-uncited-answers rule; embedding_model lets search detect a model change and
  // re-embed vectors that are no longer comparable. Both are ADDed for brains created before they existed.
  if (!cols.some((c) => c.name === "citation")) {
    exec("ALTER TABLE neurons ADD COLUMN citation TEXT NOT NULL DEFAULT ''");
  }
  if (!cols.some((c) => c.name === "embedding_model")) {
    exec("ALTER TABLE neurons ADD COLUMN embedding_model TEXT");
  }
}

// Local-only brain on bun:sqlite — the default, and what every test run uses.
function openBun(): Db {
  assertNotRealBrainInTests(config.dbPath);
  mkdirSync(dirname(config.dbPath), { recursive: true });
  const d = new BunDatabase(config.dbPath);
  ensureSchema(
    (sql) => d.query(sql) as unknown as Stmt,
    (sql) => { d.run(sql); },
    true
  );
  return {
    query: (sql) => d.query(sql) as unknown as Stmt,
    run: (sql, ...params) => { d.run(sql, ...(params as never[])); },
  };
}

// Cloud-synced brain on a libSQL embedded replica. Writes go straight to the Turso primary
// (read-your-writes keeps this process consistent without a sync), while `syncPeriod` pulls other
// devices' changes in the background. We also pull once up front so the process starts current.
function openLibsql(url: string, token: string): Db {
  const localPath = config.libsql.localPath;
  mkdirSync(dirname(localPath), { recursive: true });
  // libSQL ships as a CommonJS native addon; require it lazily so the native module loads only when
  // sync is actually configured (never in the default local path or in tests).
  const requireCjs = createRequire(import.meta.url);
  const LibsqlDatabase = requireCjs("libsql") as new (path: string, opts: Record<string, unknown>) => {
    prepare(sql: string): Stmt;
    exec(sql: string): unknown;
    sync(): unknown;
  };
  const d = new LibsqlDatabase(localPath, {
    syncUrl: url,
    authToken: token,
    syncPeriod: config.libsql.syncPeriod, // background pull cadence, in seconds (0 = manual only)
    readYourWrites: true,
  });
  _sync = () => {
    try { d.sync(); } catch (err) {
      console.error("[cairn] Turso sync failed:", err instanceof Error ? err.message : err);
    }
  };
  _sync(); // initial pull: start from the latest cloud state (degrades to the local replica if offline)
  ensureSchema((sql) => d.prepare(sql), (sql) => { d.exec(sql); }, false);
  return {
    query: (sql) => d.prepare(sql),
    // libSQL has no parameterless `run`; exec covers DDL/DELETE, prepare+run covers bound params.
    run: (sql, ...params) => { if (params.length) d.prepare(sql).run(...params); else d.exec(sql); },
  };
}

// One shared connection, opened lazily. Schema is created on first open; the backend is decided by
// whether the libSQL sync vars are present.
export function db(): Db {
  if (_db) return _db;
  _db = config.libsql.url && config.libsql.token ? openLibsql(config.libsql.url, config.libsql.token) : openBun();
  return _db;
}

/** Pull the latest from the Turso primary now. No-op unless cloud sync is active. `sync()` is
 * synchronous in the libSQL binding, so this blocks briefly until the pull completes. */
export function syncNow(): void {
  _sync?.();
}
