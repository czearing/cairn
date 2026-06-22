import { Database as BunDatabase } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { config } from "./config";
import { startBackgroundSync } from "./sync";

// The brain is opened in one of two modes, decided at open time:
//   • writer (default)         — bun:sqlite on a local file. Instant local reads/writes; what every
//                                test uses. When CAIRN_LIBSQL_URL + TOKEN are set, cloud sync runs in
//                                the BACKGROUND over libSQL's HTTP query API (sync.ts) — never as an
//                                embedded replica. The embedded replica was removed deliberately: its
//                                sync() ships DB frames and bills Turso "bytes synced" (which blew our
//                                quota), and it wedged its WAL under concurrent hook access. HTTP sync
//                                bills per-row instead and never blocks the read path.
//   • reader (CAIRN_READONLY=1) — a read-only consumer (the Claude Code hooks, read-only CLI). Opens
//                                the current brain file with bun:sqlite read-only: no sync, no write.
// Both expose the same prepared-statement surface (all/get/run), so the rest of core (neurons,
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

// Monotonic write epoch, bumped on every write through this connection. With PRAGMA data_version
// (which moves when another connection writes) it gives search.ts a cheap change-token for its
// in-memory vector cache.
let _writeEpoch = 0;
function markWrite(): void { _writeEpoch++; }

// Wrap a prepared statement so any .run() (a write) bumps the epoch; reads pass straight through. A
// fresh wrapper per query() call avoids double-counting bun's internally-cached statement objects.
function countingStmt(s: Stmt): Stmt {
  return {
    all: (...p) => s.all(...p),
    get: (...p) => s.get(...p),
    run: (...p) => { markWrite(); return s.run(...p); },
  };
}

/** A cheap token that changes whenever the brain may have changed — local writes (_writeEpoch), or
 * another connection/process writing the file (PRAGMA data_version). search.ts rebuilds its vector
 * cache only when this token moves. */
export function changeToken(): string {
  let dv = 0;
  try {
    const row = _db?.query("PRAGMA data_version").get() as { data_version?: number } | undefined;
    dv = row?.data_version ?? 0;
  } catch { /* pragma unsupported on this backend → rely on the write epoch alone */ }
  return `${_writeEpoch}:${dv}`;
}

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

// Create the neurons table and backfill columns added in later versions. Reads the schema first and
// only writes DDL when something is missing.
function ensureSchema(query: (sql: string) => Stmt, exec: (sql: string) => void, wal: boolean): void {
  if (wal) exec("PRAGMA journal_mode = WAL");
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
    query: (sql) => countingStmt(d.query(sql) as unknown as Stmt),
    run: (sql, ...params) => { markWrite(); d.run(sql, ...(params as never[])); },
  };
}

// Read-only consumer: hooks and the read-only CLI set CAIRN_READONLY=1 so they never sync or write.
// They open the local bun:sqlite brain read-only, which keeps a hook fire fast and lock-free.
function openReader(): Db {
  const path = config.dbPath; // hooks read the same local bun:sqlite brain the server writes
  if (!existsSync(path)) {
    // No brain on disk yet. Behave as an empty brain rather than throwing, so a hook that happens to
    // fire first is a harmless no-op.
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

// One shared connection, opened lazily. Read-only consumers open read-only; everyone else opens the
// local bun:sqlite brain. Cloud sync, when configured, runs in the BACKGROUND over HTTP (sync.ts).
export function db(): Db {
  if (_db) return _db;
  if (process.env.CAIRN_READONLY === "1") { _db = openReader(); return _db; }
  // The brain is ALWAYS a local bun:sqlite file: instant reads/writes, and safe under concurrent hook
  // readers via standard SQLite WAL. When cloud sync is configured it runs in the BACKGROUND over HTTP
  // (sync.ts), never on this path — so a slow/broken/unreachable cloud can't hang or corrupt the brain,
  // and cairn never opens a libSQL embedded replica (whose sync() would bill Turso "bytes synced").
  _db = openBun();
  const { url, token } = config.libsql;
  if (url && token) { try { startBackgroundSync(_db, url, token); } catch { /* sync is best-effort, never fatal */ } }
  return _db;
}
