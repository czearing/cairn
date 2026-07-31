import type { Neuron } from "./neurons.types";
import type { CairnConfig } from "./config.types";

/** A neuron paired with its embedding vector. */
export interface NeuronVector {
  neuron: Neuron;
  vec: number[];
}

/** A neuron and its vector, scored by cosine similarity to the current query. */
export interface ScoredNeuron extends NeuronVector {
  sim: number;
}

/** A search result plus its bounded semantic-and-graph relevance score (0..1). */
export type ScoredResult = Neuron & { score: number };

/** The tuning knobs a search run reads. Derived from {@link CairnConfig} so the two can never drift. */
export type SearchOptions = Pick<
  CairnConfig,
  "relevanceThreshold" | "relativeFloor" | "searchGraphBoost" | "expandSubtree" | "vectorIndexThreshold"
>;
