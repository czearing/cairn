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

interface RemoteStmt { all(...a: unknown[]): unknown[]; run(...a: unknown[]): unknown }
interface Remote { prepare(s: string): RemoteStmt; exec(s: string): unknown }
function openRemote(url: string, token: string): Remote {
  const Libsql = createRequire(import.meta.url)("libsql") as new (p: string, o: Record<string, unknown>) => Remote;
  // https:// selects the stateless HTTP transport (no streaming, no blocking sync).
  const httpUrl = url.replace(/^libsql:\/\//i, "https://").replace(/^wss?:\/\//i, "https://");
  return new Libsql(httpUrl, { authToken: token });
}

const chunk = <T>(a: T[], n: number): T[][] => { const o: T[][] = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; };

const yield_ = () => new Promise((r) => setTimeout(r, 0));

// One reconcile pass: only the id-deltas move, so after the first sync each pass is cheap. It yields
// between chunks so a large initial bootstrap can't freeze the event loop, and any failure is swallowed
// (logged) — the local brain is the source of truth for the session.
async function reconcile(local: Db, url: string, token: string): Promise<void> {
  try {
    const remote = openRemote(url, token);
    remote.exec(SCHEMA);
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
