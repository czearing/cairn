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

/** Optional Turso/libSQL cloud-sync configuration, from the `CAIRN_LIBSQL_*` variables. When `url`
 * and `token` are both set, the brain runs as a libSQL embedded replica: a local file for fast reads
 * plus write-through to a Turso cloud primary, so the same brain syncs across devices. Blank `url`
 * keeps the default local-only `bun:sqlite` brain. */
export interface LibsqlConfig {
  /** `libsql://…` URL of the Turso primary. Blank disables cloud sync. */
  url: string;
  /** Auth token for the primary. */
  token: string;
  /** Local replica file (kept separate from `dbPath` so the local-only brain stays as a backup). */
  localPath: string;
  /** Seconds between automatic background pulls from the primary (0 = manual sync only). */
  syncPeriod: number;
}

/** Resolved runtime configuration for a Cairn process. */
export interface CairnConfig {
  /** Absolute path to the SQLite brain file. */
  dbPath: string;
  /** Cloud-sync settings; active only when `libsql.url` and `libsql.token` are both set. */
  libsql: LibsqlConfig;
  embed: EmbedConfig;
  /** Cosine-similarity bar at or above which a neuron counts as relevant. */
  relevanceThreshold: number;
  /** Opt-in adaptive gate (0 = off). When >0, the effective floor for a query is
   * `max(relevanceThreshold, topScore * relativeFloor)`, trimming the weak tail relative to the best
   * match without ever capping the count. A diffuse query (low top) falls back to the absolute floor. */
  relativeFloor: number;
  /** When true, a match also pulls in its descendant subtree. Off = return only direct matches. */
  expandSubtree: boolean;
  /** Port the optional viewer serves on. */
  uiPort: number;
  /** Base URL of the viewer, used to build deep links (`/node/<id>`) to neurons. */
  uiUrl: string;
}
