import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import type { CairnConfig, EmbedProvider } from "./config.types";

const uiPort = Number(process.env.CAIRN_UI_PORT || "3737");

// Sync settings persist to ~/.cairn/config.json so EVERY Cairn process agrees on whether cloud sync
// is on and where the replica lives — including the short-lived hook processes, which don't inherit
// the MCP server's env. Environment variables still win when set (tests, migration/CLI scripts). The
// file path is overridable (CAIRN_CONFIG_PATH) so tests never read the real file.
const configFilePath = process.env.CAIRN_CONFIG_PATH || join(homedir(), ".cairn", "config.json");
function fileConfig(): {
  libsql?: { url?: string; token?: string; localPath?: string; syncPeriod?: number };
  skills?: boolean;
  usageTelemetry?: boolean;
} {
  try {
    if (!existsSync(configFilePath)) return {};
    const parsed = JSON.parse(readFileSync(configFilePath, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {}; // a malformed config file must never crash a process — fall back to env / local mode
  }
}
const parsedFile = fileConfig();
const fileCfg = parsedFile.libsql && typeof parsedFile.libsql === "object" ? parsedFile.libsql : {};

export const config: CairnConfig = {
  dbPath: process.env.CAIRN_DB_PATH || join(homedir(), ".cairn", "cairn.db"),
  libsql: {
    url: process.env.CAIRN_LIBSQL_URL || fileCfg.url || "",
    token: process.env.CAIRN_LIBSQL_TOKEN || fileCfg.token || "",
    localPath: process.env.CAIRN_LIBSQL_LOCAL || fileCfg.localPath || join(homedir(), ".cairn", "cairn-replica.db"),
    syncPeriod: Number(process.env.CAIRN_LIBSQL_SYNC_PERIOD || fileCfg.syncPeriod || "60"),
  },
  embed: {
    provider: (process.env.CAIRN_EMBED_PROVIDER || "local") as EmbedProvider,
    model: process.env.CAIRN_EMBED_MODEL || "",
    apiKey: process.env.CAIRN_EMBED_API_KEY || "",
    baseUrl: process.env.CAIRN_EMBED_BASE_URL || "",
  },
  relevanceThreshold: Number(process.env.CAIRN_RELEVANCE_THRESHOLD || "0.3"),
  relativeFloor: Number(process.env.CAIRN_RELATIVE_FLOOR || "0.85"), // adaptive gate: keep results >= 0.85*top score (0 = off)
  expandSubtree: process.env.CAIRN_SEARCH_EXPAND === "1", // off by default: return only direct matches
  vectorIndexThreshold: Number(process.env.CAIRN_VECTOR_INDEX_THRESHOLD || "50000"),
  maxAnswerChars: Number(process.env.CAIRN_MAX_ANSWER_CHARS || "2000"), // reject insanely verbose answers

  // The skill layer is ON by default now that the agent-driven learn loop is proven. Turn it OFF per-machine
  // with "skills": false in ~/.cairn/config.json (or CAIRN_SKILLS=0). Short-lived hooks read this from the
  // config file, since they don't inherit the MCP server's env.
  skills: parsedFile.skills !== false,
  usageTelemetry: parsedFile.usageTelemetry === true,

  uiPort,
  uiUrl: process.env.CAIRN_UI_URL || `http://localhost:${uiPort}`,
};

/** Is the skill-learning layer active? ON by default; CAIRN_SKILLS env wins (1 on / 0 off), else the
 *  per-machine `skills` flag in ~/.cairn/config.json (on unless explicitly set to false). Evaluated live
 *  so an env toggle takes effect at once. */
export const skillsEnabled = (): boolean =>
  process.env.CAIRN_SKILLS === "1" ? true : process.env.CAIRN_SKILLS === "0" ? false : config.skills;

/** Privacy-safe usage telemetry is local-only and OFF by default. Environment overrides are primarily
 * for tests and temporary diagnostics; persistent opt-in lives in ~/.cairn/config.json. */
export const usageTelemetryEnabled = (): boolean =>
  process.env.CAIRN_USAGE === "1"
    ? true
    : process.env.CAIRN_USAGE === "0" ? false : config.usageTelemetry;
