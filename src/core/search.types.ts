import type { Neuron } from "./neurons.types";

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

export interface SearchOptions {
  relevanceThreshold: number;
  relativeFloor: number;
  searchGraphBoost: number;
  expandSubtree: boolean;
  vectorIndexThreshold: number;
}
