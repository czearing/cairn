import { Database as BunDatabase } from "bun:sqlite";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, rmSync } from "node:fs";
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

// Monotonic write epoch, bumped on every write through this connection and every sync pull that
// applied frames. With PRAGMA data_version (which moves when another connection writes) it gives
// search.ts a cheap change-token for its in-memory vector cache.
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

/** A cheap token that changes whenever the brain may have changed — local writes and sync pulls
 * (_writeEpoch), or another connection/process writing the file (PRAGMA data_version). search.ts
 * rebuilds its vector cache only when this token moves. */
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
    query: (sql) => countingStmt(d.query(sql) as unknown as Stmt),
    run: (sql, ...params) => { markWrite(); d.run(sql, ...(params as never[])); },
  };
}

const errMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

// A corrupt/stale local replica surfaces as one of a few libSQL errors (missing wal_index, missing
// metadata, a malformed page). All are recoverable by discarding the local cache and re-syncing the
// primary, so we match them to trigger that recovery rather than dead-ending the user.
function isReplicaCorruption(err: unknown): boolean {
  const m = errMessage(err).toLowerCase();
  return m.includes("wal_index") || m.includes("metadata file") || m.includes("malformed") ||
    m.includes("invalidlocalstate") || m.includes("disk image");
}

// A corrupt data page can open cleanly and only throw on the first read, so an open-time catch isn't
// enough — do a real read up front. A genuinely corrupt page throws "malformed" here (triggering
// recovery), while benign integrity noise (e.g. a freelist-size mismatch) doesn't throw on read and a
// fresh brain with no table yet throws "no such table"; neither is corruption, so both are ignored.
function probeIntegrity(prepare: (sql: string) => Stmt): void {
  try { prepare("SELECT id FROM neurons LIMIT 1").get(); }
  catch (err) { if (isReplicaCorruption(err)) throw err; }
}

const offlineWrite = () => new Error(
  "Cairn can't reach the cloud sync right now, so it's read-only: recall still works, and new memories will save " +
  "once you're reconnected (restart Cairn). Likely a wrong/expired CAIRN_LIBSQL_TOKEN or no internet."
);

// A write can fail at delegation time even when the replica opened fine (a flaky network or a proxy
// mangling the libSQL protocol — e.g. "Invalid header bit", a handshake timeout). Match those so the
// write surfaces a plain-language message instead of a raw libSQL error.
const isCloudDown = (err: unknown): boolean => {
  const m = errMessage(err).toLowerCase();
  return m.includes("timeout") || m.includes("connect") || m.includes("handshake") || m.includes("delegation") ||
    m.includes("unreachable") || m.includes("invalid header") || m.includes("stream closed") || m.includes("transport");
};
const cloudWriteFailed = () => new Error(
  "Cairn couldn't reach the cloud to save that — it was NOT saved (likely a wrong/expired CAIRN_LIBSQL_TOKEN or " +
  "no internet). Recall still works; retry once reconnected."
);

// Cloud sync is configured but the primary is unreachable (handshake timeout, network/proxy error) or
// the replica couldn't be rebuilt. Rather than crash every command with a raw libSQL error, degrade to
// the last-synced local cache: recall keeps working read-only and writes return a plain-language
// message. Normal cloud mode resumes on the next start once connectivity is back.
function openOffline(reason: string): Db {
  console.error(`[cairn] ${reason} — running read-only on the local cache; recall works, writes pause until you reconnect.`);
  // An empty brain: reads return nothing, any write raises the friendly offline message. Used when
  // there is no usable local cache, so the tool degrades cleanly instead of throwing.
  const emptyStmt: Stmt = { all: () => [], get: () => undefined, run: () => { throw offlineWrite(); } };
  const emptyDb: Db = { query: () => emptyStmt, run: () => { throw offlineWrite(); } };
  const path = config.libsql.localPath;
  if (!existsSync(path)) return emptyDb;
  let ro: BunDatabase;
  try { ro = new BunDatabase(path, { readonly: true }); } catch { return emptyDb; }
  try { ro.run("PRAGMA busy_timeout = 2000"); } catch { /* a readonly handle may reject it; tolerated */ }
  // A never-synced replica has no neurons table; serve the empty brain rather than throwing
  // "no such table" on the first read or write.
  let hasSchema = false;
  try { hasSchema = !!ro.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='neurons'").get(); } catch { hasSchema = false; }
  if (!hasSchema) return emptyDb;
  // Reads pass through; any .run() (a write, including via query().run()) raises the friendly message.
  const offlineStmt = (s: Stmt): Stmt => ({ all: (...p) => s.all(...p), get: (...p) => s.get(...p), run: () => { throw offlineWrite(); } });
  return { query: (sql) => offlineStmt(ro.query(sql) as unknown as Stmt), run: () => { throw offlineWrite(); } };
}

// Wrap a libSQL connection (embedded replica OR direct remote) as a Db: writes bump the epoch and
// translate a cloud-down failure into a plain-language message; reads pass straight through.
function wrapCloud(d: { prepare(sql: string): Stmt; exec(sql: string): unknown }): Db {
  const translateWrite = <T>(fn: () => T): T => { try { return fn(); } catch (err) { throw isCloudDown(err) ? cloudWriteFailed() : err; } };
  const cloudStmt = (s: Stmt): Stmt => ({ all: (...p) => s.all(...p), get: (...p) => s.get(...p), run: (...p) => { markWrite(); return translateWrite(() => s.run(...p)); } });
  return {
    query: (sql) => cloudStmt(d.prepare(sql)),
    run: (sql, ...params) => { markWrite(); translateWrite(() => { if (params.length) d.prepare(sql).run(...params); else d.exec(sql); }); },
  };
}

// Direct remote connection to the primary: no local replica, no replicator/sync stream. Each query is
// a network round-trip (the in-memory cache absorbs reads after the first). This is the fallback when
// embedded-replica sync can't work on a machine — a handshake timeout or a proxy mangling the sync
// stream ("Invalid header bit") — because the remote protocol is different and usually still gets through.
function openRemote(LibsqlDatabase: new (p: string, o: Record<string, unknown>) => { prepare(sql: string): Stmt; exec(sql: string): unknown }, url: string, token: string): Db {
  // Force the HTTP transport (stateless POST /v2/pipeline) by using https:// instead of libsql://.
  // libsql:// can negotiate the Hrana streaming connection that corporate proxies / TLS-inspection
  // drop mid-response ("connection closed before message completed"); the HTTP pipeline is short
  // requests that survive those proxies.
  const httpUrl = url.replace(/^libsql:\/\//i, "https://").replace(/^wss?:\/\//i, "https://");
  console.error("[cairn] using a direct cloud connection over HTTP (works through proxies that block the sync stream; each query hits the cloud, the in-memory cache absorbs reads).");
  const d = new LibsqlDatabase(httpUrl, { authToken: token });
  ensureSchema((sql) => d.prepare(sql), (sql) => { d.exec(sql); }, false);
  return wrapCloud(d);
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
  // Escape hatch for a machine that can't run an embedded replica at all (corporate proxy mangling the
  // sync stream, etc.): CAIRN_LIBSQL_REMOTE=1 forces the direct remote connection. The automatic
  // fallback below reaches the same place on a sync failure, so most machines never need this.
  if (process.env.CAIRN_LIBSQL_REMOTE === "1") return openRemote(LibsqlDatabase, url, token);
  const opts = { syncUrl: url, authToken: token, syncPeriod: config.libsql.syncPeriod, readYourWrites: true };
  // Open the replica and pull once so the process starts on the latest cloud state. Either step can
  // throw if the local replica file is stale or corrupt (a half-finished bootstrap or a torn page).
  const bootstrap = () => { const h = new LibsqlDatabase(localPath, opts); h.sync(); probeIntegrity((s) => h.prepare(s)); return h; };

  let d: ReturnType<typeof bootstrap>;
  try {
    d = bootstrap();
  } catch (err) {
    if (isReplicaCorruption(err)) {
      // The replica is only a local cache of the primary, so a corrupt one is safe to discard: delete
      // it with its companions and re-bootstrap a clean copy from the cloud. No data is lost.
      console.error("[cairn] local replica unreadable — re-bootstrapping from the cloud:", errMessage(err));
      for (const s of ["", "-wal", "-shm", "-client_wal_index", "-info"]) { try { rmSync(localPath + s, { force: true }); } catch { /* locked file: best effort */ } }
      try { d = bootstrap(); } catch (again) { return openOffline(`cloud replica could not be rebuilt (${errMessage(again).slice(0, 70)})`); }
    } else {
      // Not corruption — embedded-replica sync failed (handshake timeout, or a proxy dropping the sync
      // stream). Don't burn minutes retrying it; go straight to a direct HTTP connection, which gets
      // through those proxies. Offline (local cache) only if that fails too.
      try { return openRemote(LibsqlDatabase, url, token); }
      catch { return openOffline(`cloud unreachable (${errMessage(err).slice(0, 70)})`); }
    }
  }

  _sync = () => {
    try {
      const res = d.sync() as { frames_synced?: number } | null | undefined;
      // A pull that applied frames means another device's changes landed → invalidate the cache. If
      // the binding doesn't report a count, bump anyway (a needless rebuild is cheap; a miss is not).
      if (!res || typeof res.frames_synced !== "number" || res.frames_synced > 0) markWrite();
    } catch (err) {
      console.error("[cairn] Turso sync failed:", errMessage(err));
    }
  };
  ensureSchema((sql) => d.prepare(sql), (sql) => { d.exec(sql); }, false);
  return wrapCloud(d);
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
