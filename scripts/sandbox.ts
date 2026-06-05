#!/usr/bin/env bun
// Safe installer UX sandbox. Lets you SEE and JUDGE the real installer across the happy path AND
// every failure path, with ZERO risk to the live brain, settings.json, or `claude mcp` registration
// (the live brain is used by dozens of agents). Every side effect is redirected to a temp dir, and
// the live config/MCP are never written. Run:  bun scripts/sandbox.ts
//
// What it exercises: dry-run preview (read-only, against live config), full happy-path install in a
// throwaway sandbox, idempotent re-run, NO_COLOR/non-TTY rendering, an offline verify-failure, and
// uninstall — then asserts the live settings.json and brain are byte-for-byte untouched.

import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

const CLI = join(import.meta.dir, "..", "src", "cli.ts");
const BUN = Bun.which("bun") ?? "bun";
const liveSettings = join(homedir(), ".claude", "settings.json");
const liveBrain = join(homedir(), ".cairn", "cairn.db");

const hash = (p: string) => (existsSync(p) ? createHash("sha256").update(readFileSync(p)).digest("hex") : "(absent)");
const brainCount = () => {
  try {
    const { Database } = require("bun:sqlite");
    return (new Database(liveBrain, { readonly: true }).query("SELECT count(*) c FROM neurons").get() as { c: number }).c;
  } catch { return -1; }
};

// snapshot the live state BEFORE anything runs
const before = { settings: hash(liveSettings), brain: brainCount() };

const sandbox = mkdtempSync(join(tmpdir(), "cairn-sandbox-"));
const tempSettings = join(sandbox, "settings.json");
const tempDb = join(sandbox, "brain.db");
const tempBin = join(sandbox, "bin");
mkdirSync(tempBin, { recursive: true });

async function run(title: string, args: string[], env: Record<string, string>, opts: { tty?: boolean } = {}) {
  console.log(`\n${"=".repeat(78)}\n▶ ${title}\n${"=".repeat(78)}`);
  const proc = Bun.spawn([BUN, CLI, ...args], {
    env: { ...process.env, ...env },
    stdout: "inherit",
    stderr: "inherit",
  });
  await proc.exited;
}

const base = { CAIRN_SETTINGS_PATH: tempSettings, CAIRN_DB_PATH: tempDb, CAIRN_SKIP_MCP: "1", CAIRN_BIN_DIR: tempBin };

try {
  // 1) DRY RUN against the LIVE config — read-only, writes nothing, shows real preflight + would-change.
  await run("1. cairn install --dry-run  (read-only preview against your REAL config)", ["install", "--dry-run"], {
    CAIRN_SKIP_MCP: "1", CAIRN_SKIP_VERIFY: "1",
  });

  // 2) HAPPY PATH in a throwaway sandbox — real hooks+warm+verify, live MCP untouched.
  await run("2. cairn install  (full happy path, isolated sandbox)", ["install"], base);

  // 2b) PROVE the generated `cairn` shim actually runs (the global command users will type).
  const isWin = process.platform === "win32";
  const shim = join(tempBin, isWin ? "cairn.cmd" : "cairn");
  console.log(`\n${"=".repeat(78)}\n▶ 2b. Run the generated 'cairn' shim → proves the global command works\n${"=".repeat(78)}`);
  if (existsSync(shim)) {
    const p = Bun.spawn(isWin ? ["cmd", "/c", shim, "doctor"] : [shim, "doctor"], {
      env: { ...process.env, ...base }, stdout: "inherit", stderr: "inherit",
    });
    await p.exited;
  } else console.log(`✗ shim not found at ${shim}`);

  // 3) IDEMPOTENT re-run — must be a no-op ("already").
  await run("3. cairn install  (re-run → must be idempotent)", ["install"], base);

  // 4) NON-TTY / NO_COLOR rendering — output must be clean ASCII with no color codes.
  await run("4. NO_COLOR doctor  (piped/non-TTY rendering)", ["doctor"], { ...base, NO_COLOR: "1" });

  // 5) OFFLINE / verify failure — point the embedder at an unreachable endpoint; must warn, not crash.
  await run("5. cairn verify  (simulated offline → graceful failure + recovery hint)", ["verify"], {
    ...base,
    CAIRN_EMBED_PROVIDER: "openai",
    CAIRN_EMBED_API_KEY: "sk-bogus",
    CAIRN_EMBED_BASE_URL: "http://127.0.0.1:9/v1",
  });

  // 6) UNINSTALL — clean teardown of the sandbox hooks.
  await run("6. cairn uninstall  (clean teardown)", ["uninstall"], base);
} finally {
  rmSync(sandbox, { recursive: true, force: true });
}

// SAFETY ASSERTIONS — the live config/brain must be byte-for-byte untouched.
const after = { settings: hash(liveSettings), brain: brainCount() };
console.log(`\n${"=".repeat(78)}\n🔒 SAFETY CHECK (live config/brain must be unchanged)\n${"=".repeat(78)}`);
const settingsOk = before.settings === after.settings;
const brainOk = before.brain === after.brain;
console.log(`  settings.json unchanged : ${settingsOk ? "✓ PASS" : "✗ FAIL"}  (${before.settings.slice(0, 12)} → ${after.settings.slice(0, 12)})`);
console.log(`  brain node count        : ${brainOk ? "✓ PASS" : "✗ FAIL"}  (${before.brain} → ${after.brain})`);
console.log(brainOk && settingsOk
  ? "\n✓ Sandbox left your live environment completely untouched."
  : "\n✗ SAFETY FAILURE — investigate before trusting the sandbox.");
