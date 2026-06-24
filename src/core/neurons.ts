import { randomUUID } from "node:crypto";
import { db } from "./db";
import { config } from "./config";
import { embed, embedModel } from "./embed";
import { encodeVector } from "./vector";
import type { Neuron, Row, NeuronPatch } from "./neurons.types";

export const vecText = (text: string, answer: string) => `${text} ${answer}`.trim();

// Defense in depth: never let control/null bytes or the Unicode replacement char into a stored
// text field. Legacy rows were poisoned by binary (embedding bytes / buffer bleed) leaking into
// text/answer/citation; stripping on write makes that class of corruption impossible to persist.
// Keeps tab/newline/return.
const stripCtrl = (s: string): string =>
  Array.from(s)
    .filter((ch) => {
      const c = ch.charCodeAt(0);
      return ch === "\t" || ch === "\n" || ch === "\r" || (c >= 32 && c !== 0xfffd);
    })
    .join("");

// Parse a stored edges array, tolerating anything malformed (a non-array or unparseable JSON → []).
// Shared by toNeuron and the edges-only helpers below so the decode rule lives in one place.
function parseEdges(json: string): string[] {
  try { const e = JSON.parse(json); return Array.isArray(e) ? e : []; } catch { return []; }
}

export function toNeuron(r: Row): Neuron {
  return { id: r.id, text: r.text, answer: r.answer, citation: r.citation, edges: parseEdges(r.edges) };
}

const dedupe = (edges: string[], self: string) => [...new Set(edges)].filter((e) => e && e !== self);
export const SELECT = "SELECT id, text, answer, citation, edges, embedding, embedding_model FROM neurons";

export function get(id: string): Neuron | null {
  const r = db().query(`${SELECT} WHERE id = ?`).get(id) as Row | null;
  return r ? toNeuron(r) : null;
}

export function all(): Neuron[] {
  return (db().query(SELECT).all() as Row[]).map(toNeuron);
}

// Edge edits read and write ONLY the `edges` column — never SELECT the row's embedding (a ~1.5KB
// BLOB) just to append or drop one id. addEdge runs once per edge on every create, so pulling the
// vector here put the embedding on the node-creation hot path for nothing.
function edgesOf(id: string): string[] | null {
  const r = db().query("SELECT edges FROM neurons WHERE id = ?").get(id) as { edges: string } | null;
  return r ? parseEdges(r.edges) : null;
}
function setEdges(id: string, edges: string[]): void {
  db().query("UPDATE neurons SET edges = ? WHERE id = ?").run(JSON.stringify(edges), id);
}

function addEdge(from: string, to: string): void {
  const edges = edgesOf(from);
  if (!edges || edges.includes(to)) return;
  setEdges(from, [...edges, to]);
}

function removeEdge(from: string, to: string): void {
  const edges = edgesOf(from);
  if (!edges || !edges.includes(to)) return;
  setEdges(from, edges.filter((e) => e !== to));
}

// Connect/disconnect two thoughts (mirrored, so the link shows on both).
export function link(a: string, b: string): void {
  if (a !== b) { addEdge(a, b); addEdge(b, a); }
}
export function unlink(a: string, b: string): void {
  removeEdge(a, b);
  removeEdge(b, a);
}

// Create a new neuron; embeds on write; mirrors edges so the graph stays undirected.
export async function create(text: string, edges: string[] = []): Promise<Neuron> {
  const id = randomUUID();
  const safeText = stripCtrl(text);
  const clean = dedupe(edges, id);
  const vec = encodeVector(await embed(vecText(safeText, "")));
  db()
    .query("INSERT INTO neurons (id, text, answer, citation, edges, embedding, embedding_model) VALUES (?, ?, '', '', ?, ?, ?)")
    .run(id, safeText, JSON.stringify(clean), vec, embedModel());
  for (const t of clean) addEdge(t, id);
  return { id, text: safeText, answer: "", citation: "", edges: clean };
}

// Partial merge. Setting `answer` marks it solved. Re-embeds on content change. Idempotent.
export async function mutate(id: string, patch: NeuronPatch): Promise<Neuron | null> {
  const cur = get(id);
  if (!cur) return null;
  const next: Neuron = {
    id,
    text: stripCtrl(patch.text ?? cur.text),
    answer: stripCtrl(patch.answer ?? cur.answer),
    citation: stripCtrl(patch.citation ?? cur.citation),
    edges: patch.edges ? dedupe(patch.edges, id) : cur.edges,
  };
  // Reject an insanely verbose answer. There is generous room for a real thought, but past the bound a
  // single node bloats every search that returns it and erodes the atomic-node discipline; tell the
  // caller to tighten it or split it into children rather than silently truncating their content.
  if (next.answer.length > config.maxAnswerChars) {
    throw new Error(
      `answer too long (${next.answer.length} chars, max ${config.maxAnswerChars}): please write it concisely and clearly. If it genuinely needs more room, split it into child nodes, each answering a single fact.`,
    );
  }
  // A neuron with an answer MUST be cited — no uncited claims in the brain.
  if (next.answer.trim() && !next.citation.trim()) {
    throw new Error("citation required: set `citation` to a real source link when giving a neuron an answer.");
  }
  if (next.text !== cur.text || next.answer !== cur.answer) {
    const vec = encodeVector(await embed(vecText(next.text, next.answer)));
    db().query("UPDATE neurons SET text = ?, answer = ?, citation = ?, edges = ?, embedding = ?, embedding_model = ? WHERE id = ?")
      .run(next.text, next.answer, next.citation, JSON.stringify(next.edges), vec, embedModel(), id);
  } else {
    // text/answer unchanged → only citation/edges can differ; leave the embedding intact
    db().query("UPDATE neurons SET citation = ?, edges = ? WHERE id = ?")
      .run(next.citation, JSON.stringify(next.edges), id);
  }
  return next;
}

export function remove(id: string): boolean {
  const info = db().query("DELETE FROM neurons WHERE id = ?").run(id);
  // Detach back-references WITHOUT loading the whole table: all() pulls every row's text/answer AND
  // its ~1.5KB embedding just to find a few neighbors. Only rows whose edges JSON contains this id can
  // reference it, so LIKE narrows to those and we read just id+edges. The exact edges.includes(id)
  // check still gates each write, so a rare LIKE substring false-positive is simply a no-op.
  const refs = db().query("SELECT id, edges FROM neurons WHERE edges LIKE ?").all(`%${id}%`) as { id: string; edges: string }[];
  for (const r of refs) {
    const edges = parseEdges(r.edges);
    if (edges.includes(id)) setEdges(r.id, edges.filter((e) => e !== id));
  }
  return info.changes > 0;
}
