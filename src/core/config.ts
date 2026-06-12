import { homedir } from "node:os";
import { join } from "node:path";
import type { CairnConfig, EmbedProvider } from "./config.types";

const uiPort = Number(process.env.CAIRN_UI_PORT || "3737");

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
  relativeFloor: Number(process.env.CAIRN_RELATIVE_FLOOR || "0"), // 0 = off; e.g. 0.5 keeps results >= half the top score
  expandSubtree: process.env.CAIRN_SEARCH_EXPAND === "1", // off by default: return only direct matches

  uiPort,
  uiUrl: process.env.CAIRN_UI_URL || `http://localhost:${uiPort}`,
};
