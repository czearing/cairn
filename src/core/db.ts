import { Database as BunDatabase } from "bun:sqlite";
import { createRequire } from "node:module";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { config } from "./config";

// The brain is opened in one of three modes, decided at open time:
//   • writer, local (default)  — bun:sqlite on a local file. Zero config; what every test uses.
//   • writer, cloud            — a libSQL embedded replica that write-throughs to a Turso primary and
//                                pulls remote changes. Active when CAIRN_LIBSQL_URL + TOKEN are set.
//   • reader (CAIRN_READONLY=1) — a read-only consumer (the Claude Code hooks, read-only CLI). Opens
//                                the current brain file with bun:sqlite read-only: no sync, no write,
//                                no cloud connection. Because bun:sqlite can read a libSQL replica
//                                file, a hook stays a ~10ms local read even while the server syncs.
// All three expose the same prepared-statement surface (all/get/run), so the rest of core (neurons,
// search) is mode-agnostic.

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
         embedding       BLOB,
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

// Read-only consumer: hooks and read-only CLI set CAIRN_READONLY=1 so they never sync, write, or hold
// the cloud connection. They open whatever file currently holds the brain — the cloud replica when
// sync is configured (shared via ~/.cairn/config.json so a hook agrees with the server on the path),
// else the local db — with bun:sqlite read-only. This keeps a hook fire fast and lock-free, and never
// stale: it reads the very replica the server maintains.
function openReader(): Db {
  const path = config.libsql.url && config.libsql.token ? config.libsql.localPath : config.dbPath;
  if (!existsSync(path)) {
    // No brain on disk yet (e.g. the server hasn't bootstrapped the replica). Behave as an empty
    // brain rather than throwing, so a hook that happens to fire first is a harmless no-op.
    const empty: Stmt = { all: () => [], get: () => undefined, run: () => ({ changes: 0 }) };
    return { query: () => empty, run: () => {} };
  }
  const d = new BunDatabase(path, { readonly: true });
  try { d.run("PRAGMA busy_timeout = 2000"); } catch { /* a readonly handle may reject it; a rare miss is tolerated */ }
  return {
    query: (sql) => d.query(sql) as unknown as Stmt,
    run: () => { throw new Error("brain is open read-only (CAIRN_READONLY=1); writes are not allowed here"); },
  };
}

// One shared connection, opened lazily. The mode is decided once: read-only consumers first, then the
// cloud writer when sync is configured, otherwise the local bun:sqlite writer.
export function db(): Db {
  if (_db) return _db;
  if (process.env.CAIRN_READONLY === "1") _db = openReader();
  else _db = config.libsql.url && config.libsql.token ? openLibsql(config.libsql.url, config.libsql.token) : openBun();
  return _db;
}

/** Pull the latest from the Turso primary now. No-op unless cloud sync is active. `sync()` is
 * synchronous in the libSQL binding, so this blocks briefly until the pull completes. */
export function syncNow(): void {
  _sync?.();
}
