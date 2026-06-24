import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Write a one-server MCP config that exposes cairn's brain tools to a spawned `claude -p`, and return its
// path. Handing this to the CLI via --mcp-config guarantees the brain is reachable independent of the
// user's ambient config (which we strip with --setting-sources project). It points at cairn's own stdio
// MCP server; CAIRN_DB_PATH defaults to the real brain via core/config unless the caller overrides it.

let cached: string | null = null;

export function cairnMcpConfigPath(): string {
  if (cached) return cached;
  const server = fileURLToPath(new URL("../mcp/server.ts", import.meta.url));
  const cfg = { mcpServers: { cairn: { command: "bun", args: [server] } } };
  const path = join(tmpdir(), "cairn-skill-mcp.json");
  writeFileSync(path, JSON.stringify(cfg));
  cached = path;
  return path;
}
