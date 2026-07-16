import { randomUUID } from "node:crypto";
import { db } from "./db";
import { config } from "./config";
import { embed, embedModel } from "./embed";
import {
  addEdge,
  edgesForSources,
  edgesFrom,
  linkBoth,
  replaceEdges,
  resyncLegacyEdges,
  sourcesTargeting,
  unlinkBoth,
} from "./graph";
import { encodeVector } from "./vector";
import {
  deleteNeuronVector,
  prepareCurrentVectorIndex,
  prepareVectorIndex,
  writeNeuronVector,
} from "./vector-store";
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

export function toNeuron(r: Row, edges = parseEdges(r.edges)): Neuron {
  return { id: r.id, text: r.text, answer: r.answer, citation: r.citation, edges };
}

const dedupe = (edges: string[], self: string) => [...new Set(edges)].filter((e) => e && e !== self);
export const SELECT = "SELECT id, text, answer, citation, edges, embedding, embedding_model FROM neurons";

export function get(id: string): Neuron | null {
  const r = db().query(`${SELECT} WHERE id = ?`).get(id) as Row | null;
  return r ? toNeuron(r, edgesFrom(id)) : null;
}

export function all(): Neuron[] {
  const rows = db().query(SELECT).all() as Row[];
  const edges = edgesForSources(rows.map((row) => row.id));
  return rows.map((row) => toNeuron(row, edges.get(row.id) ?? []));
}

/** A neuron's id, question text, and creation order (rowid). Enough to resolve a hit's edge neighbors
 * to their question and recover parent/child direction, without loading answers or embeddings. */
export interface NodeRef {
  id: string;
  text: string;
  rowid: number;
}

// Fetch id/text/rowid for a set of ids in ONE query (id-keyed). Used to turn a search hit's edge ids
// into the adjacent question text for result context; reads only the three light columns, never the
// ~1.5KB embedding. rowid is creation order, which is how a parent (always created first) is told from
// a child.
export function refsByIds(ids: string[]): Map<string, NodeRef> {
  const uniq = [...new Set(ids)].filter(Boolean);
  if (!uniq.length) return new Map();
  const rows = db()
    .query(`SELECT id, text, rowid FROM neurons WHERE id IN (${uniq.map(() => "?").join(",")})`)
    .all(...uniq) as NodeRef[];
  return new Map(rows.map((r) => [r.id, r]));
}

// Connect/disconnect two thoughts (mirrored, so the link shows on both).
export function link(a: string, b: string): void {
  if (a !== b) linkBoth(a, b);
}
export function unlink(a: string, b: string): void {
  unlinkBoth(a, b);
}

// Create a new neuron; embeds on write; mirrors edges so the graph stays undirected.
export async function create(text: string, edges: string[] = []): Promise<Neuron> {
  const id = randomUUID();
  const safeText = stripCtrl(text);
  const clean = dedupe(edges, id);
  const vec = encodeVector(await embed(vecText(safeText, "")));
  db().transaction(() => {
    prepareVectorIndex(embedModel(), vec.byteLength / 4);
    db().query("INSERT INTO neurons (id, text, answer, citation, edges, embedding, embedding_model) VALUES (?, ?, '', '', '[]', ?, ?)")
      .run(id, safeText, vec, embedModel());
    replaceEdges(id, clean);
    for (const target of clean) addEdge(target, id);
    writeNeuronVector(id, embedModel(), vec);
  });
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
    db().transaction(() => {
      prepareVectorIndex(embedModel(), vec.byteLength / 4);
      db().query("UPDATE neurons SET text = ?, answer = ?, citation = ?, embedding = ?, embedding_model = ? WHERE id = ?")
        .run(next.text, next.answer, next.citation, vec, embedModel(), id);
      if (patch.edges) replaceEdges(id, next.edges);
      writeNeuronVector(id, embedModel(), vec);
    });
  } else {
    // text/answer unchanged → only citation/edges can differ; leave the embedding intact
    db().transaction(() => {
      db().query("UPDATE neurons SET citation = ? WHERE id = ?").run(next.citation, id);
      if (patch.edges) replaceEdges(id, next.edges);
    });
  }
  return next;
}

export function remove(id: string): boolean {
  return db().transaction(() => {
    const sources = sourcesTargeting(id);
    prepareCurrentVectorIndex();
    const info = db().query("DELETE FROM neurons WHERE id = ?").run(id);
    deleteNeuronVector(id);
    resyncLegacyEdges(sources);
    return info.changes > 0;
  });
}
