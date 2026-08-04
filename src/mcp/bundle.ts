import { mkdirSync, readFileSync, renameSync, rmSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

const cairnRoot = resolve(import.meta.dir, "..", "..");
export const mcpSource = join(cairnRoot, "src", "mcp", "server.ts");
export const mcpBundle = join(cairnRoot, "dist", "mcp-server.js");
const engineServerSource = join(cairnRoot, "src", "core", "engine-server.ts");
let built = false;

// How a HOST must launch Cairn's MCP server. Bun hot reload re-evaluates the module graph in the
// running process, so a `cairn update` reaches an already-connected session without restarting it —
// src/mcp/server.ts keeps its server and tools on globalThis precisely so this refresh is in place.
// It must be the SOURCE entry, not dist/mcp-server.js: --hot holds an open handle on its entry, and on
// Windows renaming the freshly built bundle over that handle fails EPERM, so the update could not even
// land. The bundle stays for short-lived spawns (CAIRN_MCP_SERVER), which take no handle and can be
// swapped safely.
export const mcpLaunchArgs = (): string[] => ["--hot", `--cwd=${cairnRoot}`, mcpSource];

const bytes = (path: string): Buffer | null => {
  try { return readFileSync(path); } catch { return null; }
};

// Auto-update re-runs the installer on every fast-forward, and the installer rebuilds this bundle.
// Writing it in place is what wedges live sessions: an already-connected MCP server is executing the
// very file being replaced, and a running script image is mmap'd, so truncating it under the process
// takes that connection down mid-session with "Transport closed". Build to a scratch path and swap it
// in with a rename, which replaces the directory entry while leaving the old inode intact for
// anything still running it, and skip the swap entirely when the output is byte-identical.
export async function buildMcpBundle(): Promise<string> {
  if (built) return mcpBundle;
  const outdir = join(cairnRoot, "dist");
  const stagingName = `.mcp-server.${process.pid}.tmp`;
  const staging = join(outdir, stagingName);
  mkdirSync(outdir, { recursive: true });
  try {
    const result = await Bun.build({
      entrypoints: [mcpSource],
      target: "bun",
      outdir,
      naming: stagingName,
    });
    if (!result.success) {
      throw new Error(`failed to build Cairn MCP runtime: ${result.logs.join("\n")}`);
    }
    const fresh = bytes(staging);
    if (!fresh) throw new Error("failed to build Cairn MCP runtime: no output produced");
    const current = existsSync(mcpBundle) ? bytes(mcpBundle) : null;
    if (!current || !current.equals(fresh)) renameSync(staging, mcpBundle);
  } finally {
    try { rmSync(staging, { force: true }); } catch { /* already renamed away */ }
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
