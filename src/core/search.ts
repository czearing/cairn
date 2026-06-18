import { db, changeToken } from "./db";
import { config } from "./config";
import { embed, embedModel, cosine } from "./embed";
import { toNeuron, vecText, SELECT } from "./neurons";
import { encodeVector, decodeVector } from "./vector";
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
// In-memory vector cache: the long-lived server holds the decoded vectors and rebuilds only when
// db().changeToken() moves, so repeated searches skip the re-read+decode that dominates query cost
// (measured ~25x). A one-shot hook process just pays the same single load as before.
let _cache: { token: string; model: string; dim: number; vecs: NeuronVector[] } | null = null;

async function vectors(expectDim: number): Promise<NeuronVector[]> {
  const current = embedModel();
  const token = changeToken();
  if (_cache && _cache.token === token && _cache.model === current && _cache.dim === expectDim) {
    return _cache.vecs;
  }
  const rows = db().query(SELECT).all() as Row[];
  const out: NeuronVector[] = [];
  for (const r of rows) {
    // decodeVector reads both the current BLOB format and the legacy JSON string, so an un-migrated
    // brain keeps working. `legacy` marks a row still stored as the old JSON string.
    const legacy = typeof r.embedding === "string";
    let vec = decodeVector(r.embedding);
    const dimOk = !!vec && vec.length === expectDim;
    if (!dimOk) {
      vec = await embed(vecText(r.text, r.answer));
      db().query("UPDATE neurons SET embedding = ?, embedding_model = ? WHERE id = ?")
        .run(encodeVector(vec), current, r.id);
    } else if (r.embedding_model !== current) {
      if (r.embedding_model == null) {
        // legacy NULL-labeled row from the previous default: adopt the vector (keep it, stamp the
        // model) and, if it was the old JSON string, upgrade its storage to a BLOB in the same write.
        if (legacy) db().query("UPDATE neurons SET embedding = ?, embedding_model = ? WHERE id = ?").run(encodeVector(vec!), current, r.id);
        else db().query("UPDATE neurons SET embedding_model = ? WHERE id = ?").run(current, r.id);
      } else {
        vec = await embed(vecText(r.text, r.answer));
        db().query("UPDATE neurons SET embedding = ?, embedding_model = ? WHERE id = ?")
          .run(encodeVector(vec), current, r.id);
      }
    } else if (legacy) {
      // Steady state but still JSON: rewrite the SAME vector as a BLOB in place (no re-embed), so an
      // existing brain migrates itself gradually as it is searched.
      try { db().query("UPDATE neurons SET embedding = ? WHERE id = ?").run(encodeVector(vec!), r.id); } catch { /* read-only context: skip */ }
    }
    out.push({ neuron: toNeuron(r), vec: vec! });
  }
  // Read the token AFTER building: the self-heal UPDATEs above may have bumped it, and we want the
  // cache to reflect the post-rebuild state so the very next query is a hit rather than a rebuild.
  _cache = { token: changeToken(), model: current, dim: expectDim, vecs: out };
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

  const included = new Set<string>();
  for (const s of scored) if (s.sim >= floor) included.add(s.neuron.id);
  if (included.size === 0) return [];

  // Subtree expansion is opt-in (CAIRN_SEARCH_EXPAND=1, off by default). Only when on do we pay for
  // the rowid ordering and adjacency map; the default path skips that scan entirely.
  if (config.expandSubtree) {
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

    const stack = [...included];
    while (stack.length) {
      const id = stack.pop()!;
      const rank = order.get(id) ?? -1;
      for (const nb of adj.get(id) ?? []) {
        if (included.has(nb)) continue;
        if ((order.get(nb) ?? -1) > rank) { included.add(nb); stack.push(nb); } // descend only
      }
    }
  }

  return [...included]
    .map((id) => byId.get(id)!)
    .sort((a, b) => b.sim - a.sim)
    .map((s) => ({ ...s.neuron, score: Math.round(s.sim * 1000) / 1000 }));
}
