import { config } from "./config";
import type { Embedder } from "./embed.types";

// Embedding provider abstraction. Swap the model with env vars, no code change:
//   CAIRN_EMBED_PROVIDER=local   (default; runs all-MiniLM-L6-v2 in-process)
//   CAIRN_EMBED_PROVIDER=openai  (text-embedding-3-small; needs CAIRN_EMBED_API_KEY,
//                                 optional CAIRN_EMBED_BASE_URL for Azure/compatible)

const DEFAULT_MODEL: Record<string, string> = {
  local: "Xenova/all-MiniLM-L6-v2",
  openai: "text-embedding-3-small",
};

const model = () => config.embed.model || DEFAULT_MODEL[config.embed.provider] || DEFAULT_MODEL.local;
const blank = (t: string) => (t && t.trim() ? t : " ");

function unit(v: number[]): number[] {
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n) || 1;
  return v.map((x) => x / n);
}

// Vectors are unit-normalized, so cosine similarity is a dot product.
export function cosine(a: number[], b: number[]): number {
  let d = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) d += a[i]! * b[i]!;
  return d;
}

async function localEmbedder(): Promise<Embedder> {
  const { pipeline } = await import("@huggingface/transformers");
  const extract = await pipeline("feature-extraction", model());
  return async (text) => {
    const out = await extract(blank(text), { pooling: "mean", normalize: true });
    return Array.from(out.data as Float32Array);
  };
}

function apiEmbedder(): Embedder {
  const base = config.embed.baseUrl || "https://api.openai.com/v1";
  return async (text) => {
    const res = await fetch(`${base}/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.embed.apiKey}` },
      body: JSON.stringify({ model: model(), input: blank(text) }),
    });
    if (!res.ok) throw new Error(`embedding API ${res.status}: ${await res.text()}`);
    const j = (await res.json()) as { data: { embedding: number[] }[] };
    const first = j.data[0];
    if (!first) throw new Error("embedding API returned no data");
    return unit(first.embedding);
  };
}

let _embedder: Promise<Embedder> | null = null;

function embedder(): Promise<Embedder> {
  return (_embedder ??=
    config.embed.provider === "openai" ? Promise.resolve(apiEmbedder()) : localEmbedder());
}

export async function embed(text: string): Promise<number[]> {
  return (await embedder())(text);
}
