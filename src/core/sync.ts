// Background cloud sync. The local brain is a plain bun:sqlite file (fast, and concurrency-safe via
// standard SQLite WAL — unlike the libSQL embedded replica, which wedged its WAL under concurrent
// access). This module pushes new local rows up and pulls new remote rows down over libSQL's stateless
// HTTP API, on a timer, OFF the read/write path — so a slow, broken, or unreachable cloud can never
// hang or corrupt the brain. It reconciles by id (new rows both ways); a bad token or no network simply
// makes a pass a logged no-op until the next one.
import { createRequire } from "node:module";
import { config } from "./config";
import type { Db } from "./db";

type Row = { id: string; text: string; answer: string; citation: string; edges: string; embedding: unknown; embedding_model: string | null };
const COLS = "id, text, answer, citation, edges, embedding, embedding_model";
const INSERT = `INSERT OR REPLACE INTO neurons (${COLS}) VALUES (?, ?, ?, ?, ?, ?, ?)`;
const SCHEMA = `CREATE TABLE IF NOT EXISTS neurons (id TEXT PRIMARY KEY, text TEXT NOT NULL, answer TEXT NOT NULL DEFAULT '', citation TEXT NOT NULL DEFAULT '', edges TEXT NOT NULL DEFAULT '[]', embedding BLOB, embedding_model TEXT)`;
// libSQL's HTTP rows return a BLOB as a bare ArrayBuffer on bulk reads; bun:sqlite only binds a
// TypedArray, so wrap it. Strings (legacy JSON embeddings), Buffers, and null already bind fine.
const toBind = (v: unknown): unknown => (v instanceof ArrayBuffer ? new Uint8Array(v) : v);
const vals = (r: Row) => [r.id, r.text, r.answer, r.citation, r.edges, toBind(r.embedding), r.embedding_model];

interface RemoteStmt { all(...a: unknown[]): unknown[]; get(...a: unknown[]): unknown; run(...a: unknown[]): unknown }
interface Remote { prepare(s: string): RemoteStmt; exec(s: string): unknown }
function openRemote(url: string, token: string): Remote {
  const Libsql = createRequire(import.meta.url)("libsql") as new (p: string, o: Record<string, unknown>) => Remote;
  // https:// selects the stateless HTTP transport (no streaming, no blocking sync).
  const httpUrl = url.replace(/^libsql:\/\//i, "https://").replace(/^wss?:\/\//i, "https://");
  return new Libsql(httpUrl, { authToken: token });
}

const chunk = <T>(a: T[], n: number): T[][] => { const o: T[][] = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; };

const yield_ = () => new Promise((r) => setTimeout(r, 0));

// A tiny one-row marker table on the primary: `write_seq` is bumped by every client that pushes rows.
// Reading it is a single primary-key lookup — ONE billed row read — whereas COUNT(*) and `SELECT id`
// both scan the whole table (Turso bills aggregates and full scans per row, so neither is "cheap" in the
// cloud). The marker is what lets an idle sync tick cost one read instead of thousands.
// See https://docs.turso.tech/help/usage-and-billing.
const META = "CREATE TABLE IF NOT EXISTS sync_meta (k TEXT PRIMARY KEY, v INTEGER NOT NULL)";

// How often to run a full O(N) reconcile regardless of the marker. This is the safety net for rows
// written by OLDER clients that don't bump the marker (a mixed-version fleet): their new rows still
// propagate within `fullEvery` ticks. 0 = never force — trust the marker alone (a fully-upgraded fleet).
const FULL_EVERY = Math.max(0, Number(process.env.CAIRN_SYNC_FULL_EVERY || "30"));

export interface SyncState {
  tick: number;             // 1-based pass counter for this process
  localCount: number;       // current local row count (free to read on the local bun:sqlite brain)
  lastLocalCount: number;   // local count captured after the previous full pass
  remoteSeq: number | null; // current remote marker (null if the table/row is absent or unreadable)
  lastRemoteSeq: number | null; // marker captured after the previous full pass
}

// Decide whether this tick must run the full id reconcile, or can stop after the O(1) marker read:
//  • the first pass, and every `fullEvery` ticks, force a full pass (bootstrap + mixed-version safety net);
//  • otherwise run a full pass only if we have local rows to push (count moved) or the remote marker moved
//    (someone pushed). If neither moved, skip — the tick cost a single primary-key lookup.
export function needsFullSync(s: SyncState, fullEvery: number): boolean {
  if (s.tick === 1) return true;
  if (fullEvery > 0 && s.tick % fullEvery === 0) return true;
  if (s.localCount !== s.lastLocalCount) return true;
  if (s.remoteSeq === null) return true; // marker missing → be safe and reconcile
  return s.remoteSeq !== s.lastRemoteSeq;
}

// Per-process sync state, seeded so the first pass always bootstraps.
let tick = 0;
let lastLocalCount = -1;
let lastRemoteSeq: number | null = null;
let remoteReady = false; // schema + marker table ensured on the primary (once per process)

// Read the remote marker with a single primary-key lookup (1 billed row read). null when the marker
// table doesn't exist yet on the primary (an older server) — which forces a safe full pass.
function readRemoteSeq(remote: Remote): number | null {
  try {
    const r = remote.prepare("SELECT v FROM sync_meta WHERE k = 'write_seq'").get() as { v: number } | undefined;
    return r ? r.v : null;
  } catch { return null; }
}
// Bump the remote marker after we push, so other devices detect the change in one read next tick.
function bumpRemoteSeq(remote: Remote): void {
  try { remote.prepare("INSERT INTO sync_meta (k, v) VALUES ('write_seq', 1) ON CONFLICT(k) DO UPDATE SET v = v + 1").run(); }
  catch { /* best effort — a missing marker just defers detection to the periodic full pass */ }
}

// One reconcile pass: only the id-deltas move, so after the first sync each pass is cheap. It yields
// between chunks so a large initial bootstrap can't freeze the event loop, and any failure is swallowed
// (logged) — the local brain is the source of truth for the session.
async function reconcile(local: Db, url: string, token: string): Promise<void> {
  try {
    const remote = openRemote(url, token);
    // Ensure the schema + marker table exist once per process — the server keeps them across our
    // stateless HTTP connections, so re-running the idempotent DDL every tick is just wasted round-trips.
    if (!remoteReady) { remote.exec(SCHEMA); remote.exec(META); remoteReady = true; }
    tick++;

    // O(1) read-amplification gate. The local count is free (local bun:sqlite); the remote side is probed
    // with a single primary-key marker lookup, NOT a COUNT/scan (Turso bills COUNT(*) as reading every
    // row). Most idle ticks stop here having read exactly one row from the cloud.
    const localCount = (local.query("SELECT COUNT(*) AS c FROM neurons").get() as { c: number }).c;
    const forced = tick === 1 || (FULL_EVERY > 0 && tick % FULL_EVERY === 0);
    const remoteSeq = forced ? lastRemoteSeq : readRemoteSeq(remote);
    if (!needsFullSync({ tick, localCount, lastLocalCount, remoteSeq, lastRemoteSeq }, FULL_EVERY)) return;

    const cloudIds = (remote.prepare("SELECT id FROM neurons").all() as { id: string }[]).map((r) => r.id);
    const localIds = (local.query("SELECT id FROM neurons").all() as { id: string }[]).map((r) => r.id);
    const cloudSet = new Set(cloudIds), localSet = new Set(localIds);

    let pulled = 0, pushed = 0;
    const ins = local.query(INSERT);
    for (const ids of chunk(cloudIds.filter((id) => !localSet.has(id)), 400)) {
      const rows = remote.prepare(`SELECT ${COLS} FROM neurons WHERE id IN (${ids.map(() => "?").join(",")})`).all(...ids) as Row[];
      for (const r of rows) { ins.run(...vals(r)); pulled++; }
      await yield_();
    }
    const rins = remote.prepare(INSERT);
    for (const ids of chunk(localIds.filter((id) => !cloudSet.has(id)), 400)) {
      const rows = local.query(`SELECT ${COLS} FROM neurons WHERE id IN (${ids.map(() => "?").join(",")})`).all(...ids) as Row[];
      for (const r of rows) { rins.run(...vals(r)); pushed++; }
      await yield_();
    }
    // We pushed rows → bump the marker so other devices notice in a single read next tick. Then re-read
    // it so our own lastRemoteSeq reflects the post-push value (plus any concurrent device's), keeping the
    // next idle tick a clean skip. lastLocalCount advances by whatever we pulled in.
    if (pushed > 0) bumpRemoteSeq(remote);
    lastLocalCount = localCount + pulled;
    lastRemoteSeq = readRemoteSeq(remote);
    if (pulled || pushed) console.error(`[cairn] cloud sync: pulled ${pulled}, pushed ${pushed}`);
  } catch (err) {
    console.error("[cairn] cloud sync skipped (will retry):", err instanceof Error ? err.message : err);
  }
}

let started = false;
// Start the background sync loop. The initial pass is scheduled async so opening the brain never blocks
// on the network. Called once, by the long-lived MCP server (the writer); hooks/readers never sync.
export function startBackgroundSync(local: Db, url: string, token: string): void {
  if (started) return;
  started = true;
  const tick = () => { reconcile(local, url, token).catch(() => { /* never throws into the loop */ }); };
  setTimeout(tick, 50);
  const t = setInterval(tick, Math.max(15, config.libsql.syncPeriod || 60) * 1000);
  (t as unknown as { unref?: () => void }).unref?.(); // never keep the process alive just for sync
}

// One-shot reconcile, for tests and an explicit flush.
export async function syncOnce(local: Db, url: string, token: string): Promise<void> { await reconcile(local, url, token); }
