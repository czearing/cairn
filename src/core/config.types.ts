/** Which embedding backend to use. */
export type EmbedProvider = "local" | "openai";

/** Embedding configuration, sourced from the `CAIRN_EMBED_*` environment variables. */
export interface EmbedConfig {
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
  /** Port the optional viewer serves on. */
  uiPort: number;
  /** Base URL of the viewer, used to build deep links (`/node/<id>`) to neurons. */
  uiUrl: string;
}
