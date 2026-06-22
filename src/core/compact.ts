import { Database as BunDatabase } from "bun:sqlite";
import { copyFileSync, existsSync, statSync } from "node:fs";
import { config } from "./config";

// Physical compaction of the brain file. The embedding self-heal (legacy JSON → packed BLOB) and any
// bulk delete/re-embed strand freed pages on SQLite's freelist; SQLite never returns those to the OS
// on its own, so a brain can sit at several times its live size (observed in the wild: a 70MB file
// holding ~19MB of actual data, 73% dead pages). Cloud backends (Turso) bill that physical size, so
// the slack is real money. This rewrites the file compactly. It changes NO row data — it is purely a
// space reclaim — and writes a timestamped backup first.

export interface CompactResult {
  path: string;
  backupPath: string | null;
  beforeBytes: number;
  afterBytes: number;
  rows: number;
  integrityOk: boolean;
}

// YYYYMMDD-HHMMSS in local time, matching the existing ~/.cairn/*.bak naming convention.
function stamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

const count = (d: BunDatabase): number => (d.query("SELECT COUNT(*) AS c FROM neurons").get() as { c: number }).c;

// Reclaim dead pages from the brain at `opts.path` (default: the configured brain).
//
// REQUIRES exclusive access: VACUUM takes a write lock, so the long-lived MCP server must be stopped
// first. If another connection holds the brain, VACUUM raises SQLITE_BUSY after the busy_timeout and we
// surface a clear "stop the server and retry" message instead of a raw lock error. Steps: fold the WAL
// in → switch the file to INCREMENTAL auto-vacuum (so future frees are cheaply reclaimable) → VACUUM
// (the actual rewrite) → re-checkpoint → verify integrity and that the row count is unchanged.
export function compact(opts: { path?: string; backup?: boolean } = {}): CompactResult {
  const path = opts.path ?? config.dbPath;
  if (!existsSync(path)) throw new Error(`no brain at ${path} — nothing to compact.`);
  const beforeBytes = statSync(path).size;

  let backupPath: string | null = null;
  if (opts.backup !== false) {
    backupPath = `${path}.bak-${stamp(new Date())}`;
    copyFileSync(path, backupPath);
    // Copy the sidecar WAL/SHM too so the backup is a faithful point-in-time snapshot, not a half state.
    for (const ext of ["-wal", "-shm"]) if (existsSync(path + ext)) copyFileSync(path + ext, backupPath + ext);
  }

  const d = new BunDatabase(path);
  try {
    d.run("PRAGMA busy_timeout = 5000");
    const rowsBefore = count(d);
    d.run("PRAGMA wal_checkpoint(TRUNCATE)"); // fold any pending WAL into the main file before rewriting
    d.run("PRAGMA auto_vacuum = INCREMENTAL"); // applied by the VACUUM below; makes future reclaim cheap
    d.run("VACUUM"); // the space win: rewrite the file without the freelist
    d.run("PRAGMA wal_checkpoint(TRUNCATE)"); // VACUUM writes through the WAL; truncate it back down
    const integrityOk = (d.query("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check === "ok";
    const rowsAfter = count(d);
    if (rowsBefore !== rowsAfter) {
      throw new Error(`row count changed during compaction (${rowsBefore} → ${rowsAfter}); aborting.${backupPath ? ` Restore the backup at ${backupPath}.` : ""}`);
    }
    return { path, backupPath, beforeBytes, afterBytes: statSync(path).size, rows: rowsAfter, integrityOk };
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    if (/lock|busy/i.test(m)) {
      throw new Error(`the brain is in use (most likely the cairn MCP server) — stop it and retry \`cairn compact\`. (${m})`);
    }
    throw err;
  } finally {
    d.close();
  }
}
