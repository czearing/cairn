/** Which embedding backend to use. */
export type EmbedProvider = "local" | "openai";

/** Embedding configuration, sourced from the `CAIRN_EMBED_*` environment variables. */
interface EmbedConfig {
  /** `local` runs a model in-process; `openai` calls an HTTP embeddings API. */
  provider: EmbedProvider;
  /** Model id. Blank falls back to the provider's default. */
  model: string;
  /** API key for the `openai` provider. */
  apiKey: string;
  /** Base URL for an OpenAI-compatible / Azure endpoint. Blank uses OpenAI. */
  baseUrl: string;
}

/** Resolved runtime configuration for a Cairn process. */
export interface CairnConfig {
  /** Absolute path to the SQLite brain file. */
  dbPath: string;
  embed: EmbedConfig;
  /** Cosine-similarity bar at or above which a neuron counts as relevant. */
  relevanceThreshold: number;
  /** Opt-in adaptive gate (0 = off). When >0, the effective floor for a query is
   * `max(relevanceThreshold, topScore * relativeFloor)`, trimming the weak tail relative to the best
   * match without ever capping the count. A diffuse query (low top) falls back to the absolute floor. */
  relativeFloor: number;
  /** Bounded relevance boost for results linked to other relevant results in the same response. */
  searchGraphBoost: number;
  /** When true, a match also pulls in its descendant subtree. Off = return only direct matches. */
  expandSubtree: boolean;
  /** Use the exact metric index at or above this many vectors. Smaller brains use a linear scan. */
  vectorIndexThreshold: number;
  /** Minimum cosine similarity for advisory near-duplicate candidates returned after creation. */
  duplicateThreshold: number;
  /** Maximum advisory near-duplicate candidates returned after creation. */
  duplicateCandidateLimit: number;
  /** Max characters allowed in a neuron's answer. Generous room for a real thought, but a bound: an
   * answer past this is rejected so one bloated node can't dominate search payloads or smother the
   * atomic-node discipline. Callers are told to write concisely or split into child nodes. */
  maxAnswerChars: number;
  /** Whether privacy-safe local usage telemetry is active. OFF by default and never uploaded. */
  usageTelemetry: boolean;
  /** Whether the install fast-forwards itself to published releases in the background. ON by default;
   * turn it OFF per machine with `"autoUpdate": false` in ~/.cairn/config.json or `CAIRN_AUTO_UPDATE=0`.
   * A dirty or diverged checkout is never touched automatically. */
  autoUpdate: boolean;
  /** Port the optional viewer serves on. */
  uiPort: number;
  /** Base URL of the viewer, used to build deep links (`/node/<id>`) to neurons. */
  uiUrl: string;
}
