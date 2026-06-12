import { db } from "./db";
import { config } from "./config";
import { embed, embedModel, cosine } from "./embed";
import { toNeuron, vecText, SELECT } from "./neurons";
import type { Neuron, Row } from "./neurons.types";
import type { NeuronVector, ScoredNeuron, ScoredResult } from "./search.types";

// Load every neuron with a vector that is COMPARABLE to the current query, (re)embedding and
// persisting any that are not. A vector from a different model lives in a different space, so
// comparing the query against it is meaningless. `expectDim` is the current model's dimension (the
// query's), the ground-truth compatibility signal. The decision per neuron:
//   • missing / unparseable / wrong dimension → embed fresh (the only true incompatibility).
//   • dimension matches, label == current model → use as-is (the steady-state fast path).
//   • dimension matches, label is NULL → a legacy row from the previous default; ADOPT it (stamp the
//     label, keep the vector) so an existing brain doesn't re-embed every node on its first search.
//   • dimension matches, label is a DIFFERENT model → a deliberate same-dim model switch into another
//     space → re-embed to make it comparable.
// This self-heals after a CAIRN_EMBED_MODEL/PROVIDER change and backfills seed/legacy rows.
async function vectors(expectDim: number): Promise<NeuronVector[]> {
  const rows = db().query(SELECT).all() as Row[];
  const current = embedModel();
  const out: NeuronVector[] = [];
  for (const r of rows) {
    let vec: number[] | null = null;
    if (r.embedding) { try { vec = JSON.parse(r.embedding); } catch { vec = null; } }
    const dimOk = !!vec && vec.length === expectDim;
    if (!dimOk) {
      vec = await embed(vecText(r.text, r.answer));
      db().query("UPDATE neurons SET embedding = ?, embedding_model = ? WHERE id = ?")
        .run(JSON.stringify(vec), current, r.id);
    } else if (r.embedding_model !== current) {
      if (r.embedding_model == null) {
        db().query("UPDATE neurons SET embedding_model = ? WHERE id = ?").run(current, r.id);
      } else {
        vec = await embed(vecText(r.text, r.answer));
        db().query("UPDATE neurons SET embedding = ?, embedding_model = ? WHERE id = ?")
          .run(JSON.stringify(vec), current, r.id);
      }
    }
    out.push({ neuron: toNeuron(r), vec: vec! });
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
export async function search(query: string): Promise<ScoredResult[]> {
  if (!query.trim()) return [];
  const qv = await embed(query);
  const scored: ScoredNeuron[] = (await vectors(qv.length)).map((d) => ({ ...d, sim: cosine(qv, d.vec) }));
  const byId = new Map(scored.map((s) => [s.neuron.id, s]));

  // Effective relevance floor. With CAIRN_RELATIVE_FLOOR off (0) this is just the absolute threshold,
  // so behavior is unchanged. When set, it rises to a fraction of the BEST match for this query —
  // trimming the weak tail when there is a clearly-strong hit, while a diffuse query (low top score)
  // stays on the absolute floor. It is a relevance bar, never a count cap.
  const topSim = scored.reduce((m, s) => (s.sim > m ? s.sim : m), -Infinity);
  const floor =
    config.relativeFloor > 0 && Number.isFinite(topSim)
      ? Math.max(config.relevanceThreshold, topSim * config.relativeFloor)
      : config.relevanceThreshold;

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
    if (s.sim >= floor) { included.add(s.neuron.id); stack.push(s.neuron.id); }
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
    .map((s) => ({ ...s.neuron, score: Math.round(s.sim * 1000) / 1000 }));
}
