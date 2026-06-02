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
