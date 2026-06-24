import { Database } from "bun:sqlite";
import { homedir } from "node:os";
import { join } from "node:path";

// Repairs the legacy logical corruption (control/null bytes in text fields, and an edges JSON
// array written into the citation column) that predates the named-column write path.
// Dry-run by default; pass --apply to write. Back up ~/.cairn/cairn.db first.

const APPLY = process.argv.includes("--apply");
const p = process.env.CAIRN_DB_PATH || join(homedir(), ".cairn", "cairn.db");
const db = APPLY ? new Database(p, { readwrite: true }) : new Database(p, { readonly: true });

type Row = { id: string; text: string; answer: string; citation: string; edges: string };

// Cut a string at the first control byte (keep tab/newline/return); drops the binary/bleed tail.
function clean(s: string | null): string {
  if (!s) return "";
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if ((c < 32 && c !== 9 && c !== 10 && c !== 13) || c === 0xfffd) return s.slice(0, i).trimEnd();
  }
  return s;
}
const parseEdges = (s: string | null): string[] => {
  try { const v = JSON.parse(s || "[]"); return Array.isArray(v) ? v.filter((x) => typeof x === "string") : []; }
  catch { return []; }
};

const rows = db.query("SELECT id, text, answer, citation, edges FROM neurons").all() as Row[];
let fixedCtrl = 0, fixedCitArr = 0, touched = 0;
const update = db.query("UPDATE neurons SET text=?, answer=?, citation=?, edges=?, embedding=NULL WHERE id=?");

for (const r of rows) {
  const text = clean(r.text);
  const answer = clean(r.answer);
  let citation = clean(r.citation);
  let edges = parseEdges(r.edges);

  if (text !== r.text || answer !== r.answer || clean(r.citation) !== r.citation) fixedCtrl++;

  // A real citation is a URL, file path, or prose: it contains a space, a "/", or a dotted
  // extension/domain (".com", ".ts"). Leaked garbage — edges-id arrays (incl. mid-array
  // fragments) and embedding-vector floats — has none of these.
  const looksReal =
    /\s/.test(citation) ||
    citation.includes("/") ||
    /\.[A-Za-z]{2,}/.test(citation) ||
    /^[a-z][\w+.-]*:\S/i.test(citation); // URI-scheme prefix, e.g. brain:<id>, https:
  const isGarbageCitation = citation.trim() !== "" && (citation.trim().startsWith("[") || !looksReal);
  if (isGarbageCitation) {
    // salvage any UUID-looking ids (edges array) back into edges; embedding floats yield none.
    const strays = (citation.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g) ?? [])
      .filter((e) => e && e !== r.id);
    edges = [...new Set([...edges, ...strays])];
    citation = "";
    fixedCitArr++;
  }

  const changed = text !== r.text || answer !== r.answer || citation !== r.citation || JSON.stringify(edges) !== r.edges;

  if (changed) {
    touched++;
    if (touched <= 8) {
      console.log(`--- ${r.id}`);
      console.log(`   citation: ${JSON.stringify((r.citation || "").slice(0, 60))} -> ${JSON.stringify(citation.slice(0, 60))}`);
      console.log(`   answer len ${r.answer?.length ?? 0} -> ${answer.length}`);
    }
    if (APPLY) update.run(text, answer, citation, JSON.stringify(edges), r.id);
  }
}

console.log("\n" + (APPLY ? "APPLIED" : "DRY-RUN (pass --apply to write)"));
console.log("rows touched:", touched, "| control-byte fixes:", fixedCtrl, "| edges-in-citation fixes:", fixedCitArr);
if (APPLY) console.log("embeddings on repaired rows set NULL -> search() re-embeds them on next query.");
