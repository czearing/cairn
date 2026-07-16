/** One thought in the brain: a question and its answer, linked to related neurons. */
export interface Neuron {
  /** Stable unique id (UUID). */
  id: string;
  /** The question or problem. Its first line doubles as the label. */
  text: string;
  /** The solution. An empty string means the neuron is unsolved. */
  answer: string;
  /** Source link(s) backing the answer — real URLs the agent consulted. Empty if uncited. */
  citation: string;
  /** Ids of related neurons (undirected, deduped). */
  edges: string[];
}

/** A raw `neurons` table row, before parsing into a {@link Neuron}. */
export interface Row {
  id: string;
  text: string;
  answer: string;
  citation: string;
  /** Legacy JSON mirror of relational `neuron_edges`, retained for cloud/backward compatibility. */
  edges: string;
  /** The embedding vector: a packed little-endian float32 BLOB (Uint8Array), or the legacy
   * JSON-encoded string on un-migrated rows, or null until it has been computed. */
  embedding: string | Uint8Array | null;
  /** Id of the embedding model that produced {@link embedding}; null on legacy rows. A mismatch with
   * the current model means the vector is stale/incomparable and must be re-embedded before use. */
  embedding_model: string | null;
}

/** Fields accepted by `mutate`. Any omitted field is left unchanged. */
export interface NeuronPatch {
  text?: string;
  answer?: string;
  citation?: string;
  edges?: string[];
}
