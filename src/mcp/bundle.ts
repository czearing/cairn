import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

export const cairnRoot = resolve(import.meta.dir, "..", "..");
export const mcpSource = join(cairnRoot, "src", "mcp", "server.ts");
export const mcpBundle = join(cairnRoot, "dist", "mcp-server.js");
export const engineServerSource = join(cairnRoot, "src", "core", "engine-server.ts");
let built = false;

export async function buildMcpBundle(): Promise<string> {
  if (built) return mcpBundle;
  mkdirSync(join(cairnRoot, "dist"), { recursive: true });
  const result = await Bun.build({
    entrypoints: [mcpSource],
    target: "bun",
    outdir: join(cairnRoot, "dist"),
    naming: "mcp-server.js",
  });
  if (!result.success) {
    throw new Error(`failed to build Cairn MCP runtime: ${result.logs.join("\n")}`);
  }
  built = true;
  return mcpBundle;
}

export function mcpRuntimeEnv(): Record<string, string> {
  return {
    CAIRN_ROOT: cairnRoot,
    CAIRN_ENGINE_SERVER: engineServerSource,
    CAIRN_MCP_SERVER: mcpBundle,
  };
}
