import { test, expect, afterEach } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Issue #2: a Cairn MCP server kept dying mid-call and the reporter could only ever see
// "MCP error -32000: Connection closed" on the client. Bun terminates on the first unhandled
// rejection anywhere in the process, so a stray background promise took the whole brain down and
// left nothing behind to diagnose. These tests pin both halves: the process must survive, and it
// must record what happened.

const GUARD = join(import.meta.dir, "..", "src", "core", "crash-guard.ts").replace(/\\/g, "/");
const dirs: string[] = [];

function runScript(body: string): { status: number | null; stderr: string; home: string } {
  const home = mkdtempSync(join(tmpdir(), "cairn-crash-"));
  dirs.push(home);
  const file = join(home, "probe.ts");
  writeFileSync(file, body);
  const r = spawnSync("bun", [file], {
    encoding: "utf8",
    env: { ...process.env, CAIRN_DB_PATH: join(home, "cairn.db") },
  });
  return { status: r.status, stderr: r.stderr ?? "", home };
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

// The negative control. Without the guard the same fault must kill the process, otherwise the test
// below proves nothing: a passing result could just mean Bun tolerates stray rejections.
test("an unguarded process dies on a stray background rejection", () => {
  const { status, stderr } = runScript(`
    setInterval(() => {}, 1000);
    setTimeout(() => { Promise.reject(new Error("stray background rejection")); }, 10);
    setTimeout(() => { console.error("SURVIVED"); process.exit(0); }, 300);
  `);
  expect(status).not.toBe(0);
  expect(stderr).not.toContain("SURVIVED");
});

test("the crash guard keeps a server alive through a stray rejection and logs it", () => {
  const { status, stderr, home } = runScript(`
    import { installCrashGuard } from ${JSON.stringify(GUARD)};
    installCrashGuard("test-server");
    setInterval(() => {}, 1000);
    setTimeout(() => { Promise.reject(new Error("stray background rejection")); }, 10);
    setTimeout(() => { throw new Error("stray timer throw"); }, 40);
    setTimeout(() => { console.error("SURVIVED"); process.exit(0); }, 300);
  `);
  expect(status).toBe(0);
  expect(stderr).toContain("SURVIVED");

  const log = readFileSync(join(home, "crash.log"), "utf8");
  expect(log).toContain("unhandled rejection");
  expect(log).toContain("stray background rejection");
  expect(log).toContain("uncaught exception");
  expect(log).toContain("stray timer throw");
  expect(log).toContain("test-server");
});

// stdout is the MCP protocol channel. A diagnostic written there would corrupt the JSON-RPC framing
// and cause the very disconnect this guard exists to prevent.
test("the crash guard never writes to stdout", () => {
  const home = mkdtempSync(join(tmpdir(), "cairn-crash-"));
  dirs.push(home);
  const file = join(home, "probe.ts");
  writeFileSync(file, `
    import { installCrashGuard } from ${JSON.stringify(GUARD)};
    installCrashGuard("test-server");
    setTimeout(() => { Promise.reject(new Error("stray background rejection")); }, 10);
    setTimeout(() => process.exit(0), 200);
  `);
  const r = spawnSync("bun", [file], {
    encoding: "utf8",
    env: { ...process.env, CAIRN_DB_PATH: join(home, "cairn.db") },
  });
  expect(r.stdout).toBe("");
  expect(r.stderr).toContain("stray background rejection");
});
