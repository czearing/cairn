/** Turns a piece of text into a unit-normalized embedding vector. */
export type Embedder = (text: string) => Promise<number[]>;
