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
  /** JSON-encoded `string[]` of edge ids. */
  edges: string;
  /** JSON-encoded embedding vector, or null until it has been computed. */
  embedding: string | null;
}

/** Fields accepted by `mutate`. Any omitted field is left unchanged. */
export interface NeuronPatch {
  text?: string;
  answer?: string;
  citation?: string;
  edges?: string[];
}
