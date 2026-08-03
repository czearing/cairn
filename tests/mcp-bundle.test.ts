import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync, utimesSync } from "node:fs";
import { join, resolve } from "node:path";

const repository = resolve(import.meta.dir, "..");
const bun = Bun.which("bun") ?? "bun";
const bundle = join(repository, "dist", "mcp-server.js");

// buildMcpBundle memoizes per process, so each build must run in its own process to be observed.
function buildInFreshProcess(): void {
  const run = spawnSync(
    bun,
    ["-e", 'const { buildMcpBundle } = await import("./src/mcp/bundle.ts"); await buildMcpBundle();'],
    { cwd: repository, encoding: "utf8" },
  );
  if (run.status !== 0) throw new Error(`build failed: ${run.stderr}`);
}

// Auto-update re-runs the installer on every fast-forward, and the installer rebuilds this bundle.
// A live MCP server is executing that exact file, so replacing it in place takes the connection down
// mid-session with "Transport closed". The installer must therefore leave the running file alone when
// the build output has not changed, and swap rather than truncate when it has.
test("an unchanged rebuild does not touch the file a live MCP server is running", () => {
  buildInFreshProcess();
  expect(existsSync(bundle)).toBe(true);

  // Backdate so any rewrite is unambiguous rather than hidden by filesystem timestamp granularity.
  const past = new Date(Date.now() - 60_000);
  utimesSync(bundle, past, past);
  const before = statSync(bundle).mtimeMs;

  buildInFreshProcess();
  expect(statSync(bundle).mtimeMs).toBe(before);
});

test("a build leaves no staging artifact behind in dist", () => {
  buildInFreshProcess();
  const stray = readdirSync(join(repository, "dist")).filter((name) => name.startsWith(".mcp-server."));
  expect(stray).toEqual([]);
});
