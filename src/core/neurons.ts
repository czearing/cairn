import { randomUUID } from "node:crypto";
import { db } from "./db";
import { embed } from "./embed";
import type { Neuron, Row, NeuronPatch } from "./neurons.types";

export const vecText = (text: string, answer: string) => `${text} ${answer}`.trim();

export function toNeuron(r: Row): Neuron {
  let edges: string[] = [];
  try { edges = JSON.parse(r.edges); } catch { edges = []; }
  return { id: r.id, text: r.text, answer: r.answer, edges };
}

const dedupe = (edges: string[], self: string) => [...new Set(edges)].filter((e) => e && e !== self);
export const SELECT = "SELECT id, text, answer, edges, embedding FROM neurons";

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

// Create a new neuron; embeds on write; mirrors edges so the graph stays undirected.
export async function create(text: string, edges: string[] = []): Promise<Neuron> {
  const id = randomUUID();
  const clean = dedupe(edges, id);
  const vec = JSON.stringify(await embed(vecText(text, "")));
  db()
    .query("INSERT INTO neurons (id, text, answer, edges, embedding) VALUES (?, ?, '', ?, ?)")
    .run(id, text, JSON.stringify(clean), vec);
  for (const t of clean) addEdge(t, id);
  return { id, text, answer: "", edges: clean };
}

// Partial merge. Setting `answer` marks it solved. Re-embeds on content change. Idempotent.
export async function mutate(id: string, patch: NeuronPatch): Promise<Neuron | null> {
  const cur = get(id);
  if (!cur) return null;
  const next: Neuron = {
    id,
    text: patch.text ?? cur.text,
    answer: patch.answer ?? cur.answer,
    edges: patch.edges ? dedupe(patch.edges, id) : cur.edges,
  };
  if (next.text !== cur.text || next.answer !== cur.answer) {
    const vec = JSON.stringify(await embed(vecText(next.text, next.answer)));
    db().query("UPDATE neurons SET text = ?, answer = ?, edges = ?, embedding = ? WHERE id = ?")
      .run(next.text, next.answer, JSON.stringify(next.edges), vec, id);
  } else {
    // content unchanged → only edges can differ; leave the embedding intact
    db().query("UPDATE neurons SET edges = ? WHERE id = ?").run(JSON.stringify(next.edges), id);
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
