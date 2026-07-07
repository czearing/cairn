// Background cloud sync. The local brain is a plain bun:sqlite file; this module syncs it to the Turso
// primary over libSQL's stateless HTTP API on a timer, OFF the read/write path — so a slow, broken, or
// unreachable cloud can never hang or corrupt the brain. Steady state is O(delta): a server-maintained
// marker (a trigger-bumped counter) tells a consumer "something changed" in ONE row read, and rowid
// cursors move only the new rows in each direction. Because Turso bills the DB owner for every row read
// by every consumer, an O(N)-per-consumer scan does not scale — the cursors keep per-consumer cost
// proportional to actual changes, not table size. A periodic full id-diff remains as a correctness
// backstop. A bad token or no network simply makes a pass a logged no-op until the next one.
import { createRequire } from "node:module";
import { config } from "./config";
import type { Db } from "./db";

type Row = { id: string; text: string; answer: string; citation: string; edges: string; embedding: unknown; embedding_model: string | null };
const COLS = "id, text, answer, citation, edges, embedding, embedding_model";
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
const num = (v: unknown): number => (typeof v === "bigint" ? Number(v) : typeof v === "number" ? v : 0);

// ---- Server-maintained change marker -------------------------------------------------------------
// A one-row sync_meta table holds `write_seq`. Triggers on `neurons` bump it on EVERY insert/update/
// delete, so any client's write moves the marker — the DATABASE maintains it, with zero client
// cooperation and zero per-consumer config. Reading it is a single primary-key lookup (1 billed row
// read); a moved marker is all a consumer needs to know "something changed" without scanning the table.
// (Turso's recommended triggers-as-counters pattern: github.com/tursodatabase/example-billing-tips.)
const META = "CREATE TABLE IF NOT EXISTS sync_meta (k TEXT PRIMARY KEY, v INTEGER NOT NULL)";
const SEED = "INSERT INTO sync_meta (k, v) VALUES ('write_seq', 0) ON CONFLICT(k) DO NOTHING";
const BUMP = "UPDATE sync_meta SET v = v + 1 WHERE k = 'write_seq'";
const TRIGGERS = [
  `CREATE TRIGGER IF NOT EXISTS neurons_seq_ai AFTER INSERT ON neurons BEGIN ${BUMP}; END`,
  `CREATE TRIGGER IF NOT EXISTS neurons_seq_au AFTER UPDATE ON neurons BEGIN ${BUMP}; END`,
  `CREATE TRIGGER IF NOT EXISTS neurons_seq_ad AFTER DELETE ON neurons BEGIN ${BUMP}; END`,
];
// Echo-free upsert: a row already present by id is IGNOREd — zero rows written, so the trigger does NOT
// fire and the marker does NOT move. That is what stops a push/pull echo storm between consumers.
const INSERT_IGNORE = `INSERT OR IGNORE INTO neurons (${COLS}) VALUES (?, ?, ?, ?, ?, ?, ?)`;

// A periodic full id-diff, purely as a CORRECTNESS backstop (rowid reuse after deletes, a write that
// raced a cursor advance, or a client too old to maintain the marker). NOT the hot path — steady state
// is the O(delta) cursor sync below. 0 = never force.
const FULL_EVERY = Math.max(0, Number(process.env.CAIRN_SYNC_FULL_EVERY || "30"));
const CHUNK = 400;

export type SyncDecision = "skip" | "fast" | "full";
export interface SyncInputs {
  tick: number;               // 1-based pass counter for this process
  fullEvery: number;
  remoteSeq: number | null;   // current marker (null = absent/unreadable → reconcile to be safe)
  lastRemoteSeq: number | null;
  localMaxRowid: number;      // highest local rowid (a free local read)
  pushCursor: number;         // highest local rowid already pushed to the primary
}
// Decide this tick's work. The first pass and every `fullEvery` ticks run the full backstop; otherwise
// the cheap cursor path runs only when the remote marker moved (someone pushed) or we have unpushed
// local rows. If neither, skip — the tick spent one marker read.
export function decideSync(s: SyncInputs): SyncDecision {
  if (s.tick === 1) return "full";
  if (s.fullEvery > 0 && s.tick % s.fullEvery === 0) return "full";
  if (s.remoteSeq === null) return "full";
  return s.remoteSeq !== s.lastRemoteSeq || s.localMaxRowid > s.pushCursor ? "fast" : "skip";
}

// Per-process sync state.
let tick = 0;
let remoteReady = false;        // schema + marker + triggers ensured on the primary (once per process)
let lastRemoteSeq: number | null = null;
let pullCursor = 0;             // highest remote rowid pulled into the local brain
let pushCursor = 0;             // highest local rowid pushed to the primary

// Read the marker with one primary-key lookup. null when the table/row is absent (an un-provisioned
// primary) — which decideSync treats as "reconcile".
function readRemoteSeq(remote: Remote): number | null {
  try {
    const r = remote.prepare("SELECT v FROM sync_meta WHERE k = 'write_seq'").get() as { v: number | bigint } | undefined;
    return r ? num(r.v) : null;
  } catch { return null; }
}
const localMaxRowid = (local: Db): number => num((local.query("SELECT COALESCE(MAX(rowid), 0) AS m FROM neurons").get() as { m: number | bigint } | undefined)?.m);
const remoteMaxRowid = (remote: Remote): number => num((remote.prepare("SELECT COALESCE(MAX(rowid), 0) AS m FROM neurons").get() as { m: number | bigint } | undefined)?.m);

type RowRid = Row & { _rid: number | bigint };

// Pull remote rows with rowid beyond `from` into the local brain (echo-free). O(delta): the rowid index
// means only the new rows are read and billed, never the whole table. Returns the new high-water rowid.
async function pullSince(local: Db, remote: Remote, from: number): Promise<number> {
  let cursor = from;
  const ins = local.query(INSERT_IGNORE);
  const sel = remote.prepare(`SELECT rowid AS _rid, ${COLS} FROM neurons WHERE rowid > ? ORDER BY rowid LIMIT ${CHUNK}`);
  let batch: RowRid[];
  do {
    batch = sel.all(cursor) as RowRid[];
    for (const r of batch) { ins.run(...vals(r)); cursor = num(r._rid); }
    await yield_();
  } while (batch.length === CHUNK);
  return cursor;
}
// Push local rows with rowid beyond `from` to the primary (echo-free via INSERT OR IGNORE). Local reads
// are free; only a genuinely-new id costs a write (and fires the trigger that moves the marker).
async function pushSince(local: Db, remote: Remote, from: number): Promise<void> {
  let cursor = from;
  const rins = remote.prepare(INSERT_IGNORE);
  const sel = local.query(`SELECT rowid AS _rid, ${COLS} FROM neurons WHERE rowid > ? ORDER BY rowid LIMIT ${CHUNK}`);
  let batch: RowRid[];
  do {
    batch = sel.all(cursor) as RowRid[];
    for (const r of batch) { rins.run(...vals(r)); cursor = num(r._rid); }
    await yield_();
  } while (batch.length === CHUNK);
}

// The O(N) backstop: id-diff both ways and move whatever the cursors missed. Rare by design.
async function fullReconcile(local: Db, remote: Remote): Promise<void> {
  const cloudIds = (remote.prepare("SELECT id FROM neurons").all() as { id: string }[]).map((r) => r.id);
  const localIds = (local.query("SELECT id FROM neurons").all() as { id: string }[]).map((r) => r.id);
  const cloudSet = new Set(cloudIds), localSet = new Set(localIds);
  let pulled = 0, pushed = 0;
  const ins = local.query(INSERT_IGNORE);
  for (const ids of chunk(cloudIds.filter((id) => !localSet.has(id)), CHUNK)) {
    const rows = remote.prepare(`SELECT ${COLS} FROM neurons WHERE id IN (${ids.map(() => "?").join(",")})`).all(...ids) as Row[];
    for (const r of rows) { ins.run(...vals(r)); pulled++; }
    await yield_();
  }
  const rins = remote.prepare(INSERT_IGNORE);
  for (const ids of chunk(localIds.filter((id) => !cloudSet.has(id)), CHUNK)) {
    const rows = local.query(`SELECT ${COLS} FROM neurons WHERE id IN (${ids.map(() => "?").join(",")})`).all(...ids) as Row[];
    for (const r of rows) { rins.run(...vals(r)); pushed++; }
    await yield_();
  }
  if (pulled || pushed) console.error(`[cairn] cloud sync (full backstop): pulled ${pulled}, pushed ${pushed}`);
}

// One reconcile pass. Any failure is swallowed (logged) — the local brain is the source of truth.
async function reconcile(local: Db, url: string, token: string): Promise<void> {
  try {
    const remote = openRemote(url, token);
    // Provision the schema, marker, and triggers once per process — the primary keeps them across our
    // stateless HTTP connections, so re-running the idempotent DDL every tick is just wasted round-trips.
    if (!remoteReady) {
      remote.exec(SCHEMA); remote.exec(META); remote.exec(SEED);
      for (const t of TRIGGERS) remote.exec(t);
      remoteReady = true;
    }
    tick++;

    const localMax = localMaxRowid(local); // free local read
    const forced = tick === 1 || (FULL_EVERY > 0 && tick % FULL_EVERY === 0);
    const remoteSeq = forced ? lastRemoteSeq : readRemoteSeq(remote); // one read; skipped on a forced pass
    const decision = decideSync({ tick, fullEvery: FULL_EVERY, remoteSeq, lastRemoteSeq, localMaxRowid: localMax, pushCursor });
    if (decision === "skip") return;

    if (decision === "full") {
      await fullReconcile(local, remote);
      pullCursor = remoteMaxRowid(remote);
      pushCursor = localMaxRowid(local);
    } else {
      // Steady state. Push BEFORE the pull can grow the local max (so pulled rows aren't mistaken for
      // local-new), then advance pushCursor only to the pre-pull local max — any local write that
      // raced this pass still sits above the cursor and gets picked up next tick.
      await pushSince(local, remote, pushCursor);
      pullCursor = await pullSince(local, remote, pullCursor);
      pushCursor = localMax;
    }

    lastRemoteSeq = readRemoteSeq(remote); // post-state marker (includes our own trigger bumps)
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
  const fire = () => { reconcile(local, url, token).catch(() => { /* never throws into the loop */ }); };
  setTimeout(fire, 50);
  const t = setInterval(fire, Math.max(15, config.libsql.syncPeriod || 60) * 1000);
  (t as unknown as { unref?: () => void }).unref?.(); // never keep the process alive just for sync
}
