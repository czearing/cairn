import { db } from "./db";
import { config } from "./config";
import { embed, cosine } from "./embed";
import { toNeuron, vecText, SELECT } from "./neurons";
import type { Neuron, Row } from "./neurons.types";
import type { NeuronVector, ScoredNeuron } from "./search.types";

// Load every neuron with its vector, backfilling (and persisting) any missing embedding —
// e.g. rows created by the seed script — so search always has vectors to compare.
async function vectors(): Promise<NeuronVector[]> {
  const rows = db().query(SELECT).all() as Row[];
  const out: NeuronVector[] = [];
  for (const r of rows) {
    let vec: number[] | null = null;
    if (r.embedding) { try { vec = JSON.parse(r.embedding); } catch { vec = null; } }
    if (!vec || vec.length === 0) {
      vec = await embed(vecText(r.text, r.answer));
      db().query("UPDATE neurons SET embedding = ? WHERE id = ?").run(JSON.stringify(vec), r.id);
    }
    out.push({ neuron: toNeuron(r), vec });
  }
  return out;
}

// Semantic search. Neurons above the threshold are "seeds"; from each we descend INTO its
// subtree (its sub-questions and their findings), then interleave everything into one list
// ranked by relevance. A match never pulls in its parents or root. Deduped, NO count limit.
//
// Edges are stored mirrored (undirected), so direction comes from creation order: a parent is
// always created before its child, so a node's descendants are the NEWER neurons reachable
// through its edges. We expand a seed downward only, never up the tree.
export async function search(query: string): Promise<Neuron[]> {
  if (!query.trim()) return [];
  const qv = await embed(query);
  const scored: ScoredNeuron[] = (await vectors()).map((d) => ({ ...d, sim: cosine(qv, d.vec) }));
  const byId = new Map(scored.map((s) => [s.neuron.id, s]));

  const order = new Map<string, number>();
  (db().query("SELECT id FROM neurons ORDER BY rowid").all() as { id: string }[])
    .forEach((r, i) => order.set(r.id, i));

  const adj = new Map<string, Set<string>>();
  for (const s of scored) adj.set(s.neuron.id, new Set());
  for (const s of scored) {
    for (const e of s.neuron.edges) {
      if (!adj.has(e)) continue;
      adj.get(s.neuron.id)!.add(e);
      adj.get(e)!.add(s.neuron.id);
    }
  }

  const included = new Set<string>();
  const stack: string[] = [];
  for (const s of scored) {
    if (s.sim >= config.relevanceThreshold) { included.add(s.neuron.id); stack.push(s.neuron.id); }
  }
  if (included.size === 0) return [];
  // Subtree expansion is toggleable (CAIRN_SEARCH_EXPAND=1). Off by default so search returns only
  // the direct matches, not their descendants, to keep results tight.
  while (config.expandSubtree && stack.length) {
    const id = stack.pop()!;
    const rank = order.get(id) ?? -1;
    for (const nb of adj.get(id) ?? []) {
      if (included.has(nb)) continue;
      if ((order.get(nb) ?? -1) > rank) { included.add(nb); stack.push(nb); } // descend only
    }
  }

  return [...included]
    .map((id) => byId.get(id)!)
    .sort((a, b) => b.sim - a.sim)
    .map((s) => s.neuron);
}
