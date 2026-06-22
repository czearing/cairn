import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { compact } from "../src/core/compact";

const SCHEMA =
  "CREATE TABLE neurons (id TEXT PRIMARY KEY, text TEXT NOT NULL, answer TEXT NOT NULL DEFAULT '', " +
  "citation TEXT NOT NULL DEFAULT '', edges TEXT NOT NULL DEFAULT '[]', embedding BLOB, embedding_model TEXT)";

// Build a brain whose file is bloated with freelist pages: insert many big-BLOB rows, then delete most
// of them so the freed pages strand on the freelist (SQLite won't return them without a VACUUM).
function bloatedBrain(keep: number, drop: number): { path: string; before: number } {
  const path = join(tmpdir(), `cairn-compact-${randomUUID()}.db`);
  const d = new Database(path);
  d.run("PRAGMA journal_mode = WAL");
  d.run(SCHEMA);
  const big = new Uint8Array(4096).fill(7); // ~4KB blob/row → real pages, like an embedding column
  const ins = d.query("INSERT INTO neurons (id, text, embedding) VALUES (?, 'q', ?)");
  const tx = d.transaction(() => { for (let i = 0; i < keep + drop; i++) ins.run(`n${i}`, big); });
  tx();
  d.query("DELETE FROM neurons WHERE id NOT IN (SELECT id FROM neurons LIMIT ?)").run(keep);
  d.run("PRAGMA wal_checkpoint(TRUNCATE)");
  const before = statSync(path).size;
  d.close();
  return { path, before };
}

test("compact: reclaims freed pages and preserves every row", () => {
  const { path, before } = bloatedBrain(50, 1500);
  const r = compact({ path, backup: false });
  expect(r.rows).toBe(50);
  expect(r.integrityOk).toBe(true);
  expect(r.afterBytes).toBeLessThan(before); // the freelist slack is gone
  // the surviving rows are intact and readable through a fresh connection
  const d = new Database(path, { readonly: true });
  expect((d.query("SELECT COUNT(*) AS c FROM neurons").get() as { c: number }).c).toBe(50);
  d.close();
});

test("compact: writes a backup by default", () => {
  const { path } = bloatedBrain(10, 200);
  const r = compact({ path });
  expect(r.backupPath).toBeTruthy();
  expect(existsSync(r.backupPath!)).toBe(true);
});

test("compact: a missing brain is a clear error, not a crash", () => {
  const path = join(tmpdir(), `cairn-missing-${randomUUID()}.db`);
  expect(() => compact({ path, backup: false })).toThrow(/no brain at/);
});
