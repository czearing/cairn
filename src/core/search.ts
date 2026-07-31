import { db, searchChangeToken } from "./db";
import { config, searchOptionsFromConfig } from "./config";
import { embed, embedModel, cosine } from "./embed";
import { edgesForSources } from "./graph";
import { toNeuron, vecText, SELECT } from "./neurons";
import { encodeVector, decodeVector } from "./vector";
import { exactVectorCandidates } from "./vector-index";
import {
  prepareVectorIndex,
  repairVectorIndexCoverage,
  writeNeuronVector,
} from "./vector-store";
import { rerankConnectedResults } from "./search-rerank";
import { recordTelemetry } from "./telemetry-record";
import type { Neuron, Row } from "./neurons.types";
import type {
  NeuronVector,
  ScoredNeuron,
  ScoredResult,
  SearchOptions,
} from "./search.types";
import type { TelemetryEvent } from "./telemetry-record-types";

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
let _warmup: Promise<void> | null = null;
let _cacheRefresh: Promise<void> | null = null;
type SearchTelemetryIdentity = Pick<
  TelemetryEvent,
  "releaseFingerprint" | "version" | "runClass"
>;

function searchStage(
  source: string,
  started: number,
  itemCount: number,
  identity: SearchTelemetryIdentity | null,
): void {
  if (!identity) return;
  recordTelemetry({
    kind: "search_stage",
    source,
    toolName: "brain_search",
    durationMs: performance.now() - started,
    itemCount,
    ...identity,
  });
}

function persistVector(id: string, vector: number[], model: string): void {
  const encoded = encodeVector(vector);
  db().transaction(() => {
    prepareVectorIndex(model, vector.length);
    db().query("UPDATE neurons SET embedding = ?, embedding_model = ? WHERE id = ?")
      .run(encoded, model, id);
    writeNeuronVector(id, model, encoded);
  });
}

async function vectors(
  expectDim: number,
  telemetry: SearchTelemetryIdentity | null,
): Promise<NeuronVector[]> {
  const current = embedModel();
  const loadToken = searchChangeToken();
  if (_cache && _cache.token === loadToken && _cache.model === current && _cache.dim === expectDim) {
    searchStage("vector_cache_hit", performance.now(), _cache.vecs.length, telemetry);
    return _cache.vecs;
  }
  const loadStarted = performance.now();
  const rows = db().query(SELECT).all() as Row[];
  const graphStarted = performance.now();
  const graphEdges = edgesForSources(rows.map((row) => row.id));
  searchStage("graph_load", graphStarted, graphEdges.size, telemetry);
  const out: NeuronVector[] = [];
  for (const r of rows) {
    // decodeVector reads both the current BLOB format and the legacy JSON string, so an un-migrated
    // brain keeps working. `legacy` marks a row still stored as the old JSON string.
    const legacy = typeof r.embedding === "string";
    let vec = decodeVector(r.embedding);
    const dimOk = !!vec && vec.length === expectDim;
    if (!dimOk) {
      vec = await embed(vecText(r.text, r.answer));
      persistVector(r.id, vec, current);
    } else if (r.embedding_model !== current) {
      if (r.embedding_model == null) {
        // legacy NULL-labeled row from the previous default: adopt the vector (keep it, stamp the
        // model) and, if it was the old JSON string, upgrade its storage to a BLOB in the same write.
        persistVector(r.id, vec!, current);
      } else {
        vec = await embed(vecText(r.text, r.answer));
        persistVector(r.id, vec, current);
      }
    } else if (legacy) {
      // Steady state but still JSON: rewrite the SAME vector as a BLOB in place (no re-embed), so an
      // existing brain migrates itself gradually as it is searched.
      try { persistVector(r.id, vec!, current); } catch { /* read-only context: skip */ }
    }
    out.push({ neuron: toNeuron(r, graphEdges.get(r.id) ?? []), vec: vec! });
  }
  // A concurrent write can land while rows are being decoded. Cache only a snapshot whose token stayed
  // stable for the whole build; self-healing writes also intentionally require one clean follow-up build.
  if (searchChangeToken() === loadToken) {
    _cache = { token: loadToken, model: current, dim: expectDim, vecs: out };
  }
  searchStage("vector_cache_miss", loadStarted, out.length, telemetry);
  return out;
}

function hasCurrentVectorCache(expectDim: number): boolean {
  return Boolean(
    _cache
    && _cache.token === searchChangeToken()
    && _cache.model === embedModel()
    && _cache.dim === expectDim,
  );
}

function refreshVectorCache(expectDim: number): void {
  if (_cacheRefresh) return;
  const pending = new Promise<void>((resolve) => setTimeout(resolve, 0))
    .then(() => vectors(expectDim, null))
    .then(() => {}, () => {});
  _cacheRefresh = pending;
  pending.finally(() => {
    if (_cacheRefresh === pending) _cacheRefresh = null;
  });
}

// Semantic search. Neurons above the threshold are "seeds"; from each we descend INTO its
// subtree (its sub-questions and their findings), then interleave everything into one list
// ranked by relevance. A match never pulls in its parents or root. Deduped, NO count limit.
//
// Edges are stored mirrored (undirected), so direction comes from creation order: a parent is
// always created before its child, so a node's descendants are the NEWER neurons reachable
// through its edges. We expand a seed downward only, never up the tree.
async function executeSearch(
  query: string,
  telemetry: SearchTelemetryIdentity | null,
  preferLinearCache = false,
  options: SearchOptions = configuredSearchOptions(),
): Promise<ScoredResult[]> {
  if (!query.trim()) return [];
  const embedStarted = performance.now();
  const qv = await embed(query);
  searchStage("embed_query", embedStarted, 1, telemetry);
  if (!options.expandSubtree && !preferLinearCache && !hasCurrentVectorCache(qv.length)) {
    let indexEligible = false;
    const indexStarted = performance.now();
    try {
      const total = (db().query("SELECT COUNT(*) AS count FROM neurons").get() as { count: number }).count;
      if (total >= options.vectorIndexThreshold) {
        prepareVectorIndex(embedModel(), qv.length);
        indexEligible = true;
      }
    } catch { /* read-only consumers use the exact linear fallback */ }
    searchStage("vector_index", indexStarted, 1, telemetry);
    const retrieveStarted = performance.now();
    let indexed = exactVectorCandidates(
      qv,
      embedModel(),
      options.relevanceThreshold,
      options.relativeFloor,
      options.vectorIndexThreshold
    );
    if (indexed === null && indexEligible) {
      try {
        repairVectorIndexCoverage(embedModel(), qv.length);
        indexed = exactVectorCandidates(
          qv,
          embedModel(),
          options.relevanceThreshold,
          options.relativeFloor,
          options.vectorIndexThreshold,
        );
      } catch { /* read-only consumers use the exact linear fallback */ }
    }
    searchStage("vector_retrieve", retrieveStarted, indexed?.length ?? 0, telemetry);
    if (indexed) {
      const byId = new Map<string, Neuron>();
      const allIds = indexed.map((item) => item.id);
      const graphStarted = performance.now();
      const graphEdges = edgesForSources(allIds);
      for (let start = 0; start < indexed.length; start += 500) {
        const ids = indexed.slice(start, start + 500).map((item) => item.id);
        const rows = db().query(`${SELECT} WHERE id IN (${ids.map(() => "?").join(",")})`).all(...ids) as Row[];
        for (const row of rows) byId.set(row.id, toNeuron(row, graphEdges.get(row.id) ?? []));
      }
      searchStage("graph_load", graphStarted, byId.size, telemetry);
      const rerankStarted = performance.now();
      const result = rerankConnectedResults(
        indexed
          .map((item) => ({ ...byId.get(item.id)!, score: Math.round(item.score * 1000) / 1000 }))
          .filter((item) => item.id),
        options.searchGraphBoost,
      );
      searchStage("rerank", rerankStarted, result.length, telemetry);
      refreshVectorCache(qv.length);
      return result;
    }

  }
  const retrieveStarted = performance.now();
  const scored: ScoredNeuron[] = (await vectors(qv.length, telemetry))
    .map((entry) => ({ ...entry, sim: cosine(qv, entry.vec) }));
  searchStage("vector_retrieve", retrieveStarted, scored.length, telemetry);
  const byId = new Map(scored.map((s) => [s.neuron.id, s]));

  // Effective relevance floor. With CAIRN_RELATIVE_FLOOR off (0) this is just the absolute threshold,
  // so behavior is unchanged. When set, it rises to a fraction of the BEST match for this query —
  // trimming the weak tail when there is a clearly-strong hit, while a diffuse query (low top score)
  // stays on the absolute floor. It is a relevance bar, never a count cap.
  const topSim = scored.reduce((m, s) => (s.sim > m ? s.sim : m), -Infinity);
  const floor =
    options.relativeFloor > 0 && Number.isFinite(topSim)
      ? Math.max(options.relevanceThreshold, topSim * options.relativeFloor)
      : options.relevanceThreshold;

  const included = new Set<string>();
  for (const s of scored) if (s.sim >= floor) included.add(s.neuron.id);
  if (included.size === 0) return [];

  // Subtree expansion is opt-in (CAIRN_SEARCH_EXPAND=1, off by default). Only when on do we pay for
  // the rowid ordering and adjacency map; the default path skips that scan entirely.
  if (options.expandSubtree) {
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

  const rerankStarted = performance.now();
  const result = rerankConnectedResults(
    [...included]
      .map((id) => byId.get(id)!)
      .sort((a, b) => b.sim - a.sim)
      .map((s) => ({ ...s.neuron, score: Math.round(s.sim * 1000) / 1000 })),
    options.searchGraphBoost,
  );
  searchStage("rerank", rerankStarted, result.length, telemetry);
  return result;
}

export function warmSearchEngine(): Promise<void> {
  if (!_warmup) {
    const pending = executeSearch("Cairn search engine warmup", null, true).then(() => {});
    _warmup = pending;
    pending.catch(() => {
      if (_warmup === pending) _warmup = null;
    });
  }
  return _warmup;
}

export async function search(
  query: string,
  telemetry: SearchTelemetryIdentity | null = null,
  options: SearchOptions = configuredSearchOptions(),
): Promise<ScoredResult[]> {
  if (!query.trim()) return [];
  const warmup = _warmup;
  if (warmup) {
    try {
      await warmup;
    } catch {
      // A failed background warmup must not prevent the real search from retrying.
    }
  }
  return executeSearch(query, telemetry, false, options);
}

function configuredSearchOptions(): SearchOptions {
  return searchOptionsFromConfig();
}
