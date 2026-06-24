import { Database } from "bun:sqlite";
import { homedir } from "node:os";
import { join } from "node:path";

const p = process.env.CAIRN_DB_PATH || join(homedir(), ".cairn", "cairn.db");
const db = new Database(p, { readonly: true });

type Row = { rowid: number; id: string; text: string; answer: string; citation: string; edges: string };
const rows = db.query("SELECT rowid, id, text, answer, citation, edges FROM neurons ORDER BY rowid").all() as Row[];

function hasCtrl(s: string | null): boolean {
  if (!s) return false;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 32 && c !== 9 && c !== 10 && c !== 13) return true;
    if (c === 0xfffd) return true;
  }
  return false;
}
const isArr = (s: string | null) => !!s && s.trim().startsWith("[");
const bad = (r: Row) => hasCtrl(r.text) || hasCtrl(r.answer) || hasCtrl(r.citation) || isArr(r.citation);

const maxRowid = rows[rows.length - 1]!.rowid;
const corrupt = rows.filter(bad);
const rowids = corrupt.map((r) => r.rowid);
console.log("total rows:", rows.length, "max rowid:", maxRowid);
console.log("corrupt rows:", corrupt.length);
console.log("corrupt rowid min/max:", Math.min(...rowids), "/", Math.max(...rowids));
// bucket by rowid decile to see if corruption is legacy (low rowid) or ongoing (high rowid)
const buckets = new Array(10).fill(0);
for (const r of corrupt) buckets[Math.min(9, Math.floor((r.rowid / maxRowid) * 10))]++;
console.log("corruption by rowid decile (0=oldest .. 9=newest):", JSON.stringify(buckets));
// how many corrupt rows are in the newest 10% of the table?
const newestCutoff = maxRowid * 0.9;
console.log("corrupt rows in newest 10% of table:", corrupt.filter((r) => r.rowid >= newestCutoff).length);
