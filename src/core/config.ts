import { homedir } from "node:os";
import { join } from "node:path";
import type { CairnConfig, EmbedProvider } from "./config.types";

// All configuration comes from the environment — one place, no config files to hunt for.
export const config: CairnConfig = {
  dbPath: process.env.CAIRN_DB_PATH || join(homedir(), ".cairn", "cairn.db"),
  embed: {
    provider: (process.env.CAIRN_EMBED_PROVIDER || "local") as EmbedProvider,
    model: process.env.CAIRN_EMBED_MODEL || "",
    apiKey: process.env.CAIRN_EMBED_API_KEY || "",
    baseUrl: process.env.CAIRN_EMBED_BASE_URL || "",
  },
  relevanceThreshold: Number(process.env.CAIRN_RELEVANCE_THRESHOLD || "0.3"),
};
