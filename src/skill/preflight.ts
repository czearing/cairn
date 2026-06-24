import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { BIN } from "./claude";
import { cairnMcpServerPath } from "./cairn-mcp";

// Preflight for the skill feature: verify its dependencies up front and, on any failure, name the exact
// fix, so a missing claude CLI or unresolved server is a loud warning rather than a silent half-working
// feature. Mirrors the flutter-doctor pattern. The cheap presence checks are sync; auth is verified on the
// first real call (which degrades to null, never crashes).

export interface Check { name: string; ok: boolean; fix: string }

// True if `bin --version` runs and exits 0, within a short bound. Never throws.
function runsOk(bin: string): boolean {
  try {
    const r = spawnSync(bin, ["--version"], { stdio: "ignore", timeout: 10_000, windowsHide: true });
    return r.status === 0;
  } catch { return false; }
}

/** Run the skill-feature preflight checks. The feature is ready only if every check is ok. */
export function skillPreflight(): Check[] {
  const server = cairnMcpServerPath();
  return [
    { name: "claude CLI", ok: runsOk(BIN), fix: "install Claude Code, then run `claude` once to log in (or set CAIRN_CLAUDE_BIN)" },
    { name: "bun", ok: runsOk(process.platform === "win32" ? "bun.exe" : "bun"), fix: "install bun from https://bun.sh" },
    { name: "cairn MCP server", ok: existsSync(server), fix: `set CAIRN_MCP_SERVER to the cairn server path (looked at ${server})` },
  ];
}

/** Convenience: are all preflight checks passing? */
export const skillReady = (): boolean => skillPreflight().every((c) => c.ok);
