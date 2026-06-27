import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
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

// The resolved embedding-model id (the provider default unless CAIRN_EMBED_MODEL overrides). Stored
// next to each vector so search can detect a model change and re-embed now-incomparable old vectors.
export const embedModel = (): string =>
  config.embed.model || DEFAULT_MODEL[config.embed.provider] || DEFAULT_MODEL.local!;
const blank = (t: string) => (t && t.trim() ? t : " ");

function unit(v: number[]): number[] {
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n) || 1;
  return v.map((x) => x / n);
}

// Vectors are unit-normalized, so cosine similarity is a dot product.
//
// A length mismatch means the two vectors came from different embedding models (e.g. 384-dim MiniLM
// vs 1536-dim OpenAI). Those spaces are incomparable, so there is no real similarity to report —
// return -1 (maximally dissimilar) rather than silently dotting the shared prefix, which would
// invent a meaningless score and could let an unrelated neuron clear the relevance threshold.
export function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length) return -1;
  let d = 0;
  for (let i = 0; i < a.length; i++) d += a[i]! * b[i]!;
  return d;
}

// Bound a model load/download so a slow or blocked fetch can never hang the process forever.
function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() =>
      reject(new Error(`Cairn timed out ${what} after ${Math.round(ms / 1000)}s — the local model download is slow or blocked. Check your connection; it is cached after the first successful load.`)), ms)),
  ]);
}

async function localEmbedder(): Promise<Embedder> {
  const tf = await import("@huggingface/transformers");
  // ONE shared model cache (~/.cairn/models) so the model downloads ONCE — during install — and every
  // Cairn process reuses it. transformers.js's default cache is cwd-relative, so the MCP server (a
  // different cwd than install) would otherwise re-download it on the user's first search.
  try { (tf.env as { cacheDir?: string }).cacheDir = join(homedir(), ".cairn", "models"); } catch { /* older builds */ }
  const model = embedModel();
  const timeoutMs = Number(process.env.CAIRN_EMBED_TIMEOUT_MS || "120000");
  console.error(`[cairn] loading the embedding model (q8, ~25MB one-time download, then cached)…`);
  // q8 quantized weights are ~25MB vs ~80MB fp32 — 3x smaller download, ranking unchanged for this model.
  const extract = await withTimeout(tf.pipeline("feature-extraction", model, { dtype: "q8" }), timeoutMs, `loading the embedding model "${model}"`);
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
      body: JSON.stringify({ model: embedModel(), input: blank(text) }),
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
  if (!_embedder) {
    _embedder = config.embed.provider === "openai" ? Promise.resolve(apiEmbedder()) : localEmbedder();
    _embedder.catch(() => { _embedder = null; }); // a transient load failure can be retried next call
  }
  return _embedder;
}

// In-process embedding (loads the model in THIS process). Used directly by the sidecar and as the fallback.
export async function embedInProcess(text: string): Promise<number[]> {
  return (await embedder())(text);
}

export const LOCKFILE = join(homedir(), ".cairn", "embed-server.json");

// Pure: is the sidecar described by this lockfile usable for the CURRENT model? It must have a port AND have
// been started with the same model id, otherwise its vectors live in a different space than our queries (a
// silent-wrong-match risk that search.ts can't catch when two models share a dimension). Returns the port or
// null. Exported for tests.
export function sidecarPort(lockJson: string, currentModel: string): number | null {
  try {
    const l = JSON.parse(lockJson) as { port?: number; model?: string };
    return l.port && l.model === currentModel ? l.port : null;
  } catch { return null; }
}

// Ask the warm sidecar to embed; null on any miss (no server, model mismatch, refused, slow, bad response).
async function tryServer(text: string): Promise<number[] | null> {
  let port: number | null;
  try { port = sidecarPort(readFileSync(LOCKFILE, "utf8"), embedModel()); } catch { return null; }
  if (!port) return null;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/embed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return null;
    const j = (await res.json()) as { vec?: number[] };
    return Array.isArray(j.vec) && j.vec.length ? j.vec : null;
  } catch { return null; }
}

let _spawned = false;
function ensureServer(): void {
  if (_spawned) return;
  _spawned = true; // once per process: only the first cold call (server down) starts it
  try {
    const bin = process.platform === "win32" ? "bun.exe" : "bun";
    const path = fileURLToPath(new URL("./embed-server.ts", import.meta.url));
    spawn(bin, [path], { detached: true, stdio: "ignore", windowsHide: true, env: { ...process.env } }).unref();
  } catch { /* best-effort: the in-process fallback still serves this call */ }
}

// Public embed: prefer the warm sidecar (one shared model load across one-shot hook processes), else embed
// in-process and start the sidecar for next time. Skipped for the API provider (no local model to warm) and
// whenever CAIRN_EMBED_NO_SERVER=1 (the sidecar itself, and the test run).
export async function embed(text: string): Promise<number[]> {
  // Skip the sidecar for the API provider (no local model), when explicitly disabled (the sidecar itself),
  // and for any throwaway/temp db (every test run uses one) so a test can never spawn or reach a sidecar,
  // regardless of how a subprocess inherited its env.
  if (config.embed.provider !== "local" || process.env.CAIRN_EMBED_NO_SERVER === "1" || config.dbPath.startsWith(tmpdir())) return embedInProcess(text);
  const v = await tryServer(text);
  if (v) return v;
  ensureServer();
  return embedInProcess(text);
}
