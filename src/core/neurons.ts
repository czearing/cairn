import { randomUUID } from "node:crypto";
import { db } from "./db";
import { embed, embedModel } from "./embed";
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

export function toNeuron(r: Row): Neuron {
  let edges: string[] = [];
  try { edges = JSON.parse(r.edges); } catch { edges = []; }
  return { id: r.id, text: r.text, answer: r.answer, citation: r.citation, edges };
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

function addEdge(from: string, to: string): void {
  const n = get(from);
  if (!n || n.edges.includes(to)) return;
  db().query("UPDATE neurons SET edges = ? WHERE id = ?").run(JSON.stringify([...n.edges, to]), from);
}

function removeEdge(from: string, to: string): void {
  const n = get(from);
  if (!n || !n.edges.includes(to)) return;
  db().query("UPDATE neurons SET edges = ? WHERE id = ?").run(JSON.stringify(n.edges.filter((e) => e !== to)), from);
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
  const vec = JSON.stringify(await embed(vecText(safeText, "")));
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
  // A neuron with an answer MUST be cited — no uncited claims in the brain.
  if (next.answer.trim() && !next.citation.trim()) {
    throw new Error("citation required: set `citation` to a real source link when giving a neuron an answer.");
  }
  if (next.text !== cur.text || next.answer !== cur.answer) {
    const vec = JSON.stringify(await embed(vecText(next.text, next.answer)));
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
  for (const n of all()) {
    if (n.edges.includes(id)) {
      db().query("UPDATE neurons SET edges = ? WHERE id = ?")
        .run(JSON.stringify(n.edges.filter((e) => e !== id)), n.id);
    }
  }
  return info.changes > 0;
}
