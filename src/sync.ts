// `cairn sync` — connect this device to a shared cloud brain (Turso), or show the current connection.
//   cairn sync <url> <token>   validate the creds, THEN save them (so a broken setup can never persist)
//   cairn sync                 show status + the exact command to connect another device
//   cairn sync off             turn cloud sync off (back to the local brain)
// Creds live only in ~/.cairn/config.json (read by the CLI, the hooks, and the MCP server) — never the repo.
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { createRequire } from "node:module";
import { c, sym, line } from "./term";

const configPath = () => process.env.CAIRN_CONFIG_PATH || join(homedir(), ".cairn", "config.json");
const SERVER = join(resolve(import.meta.dir, ".."), "src", "mcp", "server.ts").replace(/\\/g, "/");
const bun = () => (Bun.which("bun") ?? "bun").replace(/\\/g, "/");
const mcpName = () => process.env.CAIRN_MCP_NAME || "cairn";

type LibsqlCfg = { url?: string; token?: string; localPath?: string; syncPeriod?: number };

function readLibsql(): LibsqlCfg {
  try { const p = configPath(); if (!existsSync(p)) return {}; const j = JSON.parse(readFileSync(p, "utf8")); return (j && j.libsql) || {}; } catch { return {}; }
}
function writeLibsql(cfg: LibsqlCfg | null): void {
  const p = configPath();
  let j: Record<string, unknown> = {};
  try { if (existsSync(p)) j = JSON.parse(readFileSync(p, "utf8")) || {}; } catch { j = {}; }
  if (cfg) j.libsql = cfg; else delete j.libsql;
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, `${JSON.stringify(j, null, 2)}\n`, "utf8");
}

// Validate creds by connecting REMOTELY (no local replica, so it works on every machine — and it's the
// same path db() falls back to). Returns the neuron count, or throws so the caller can classify.
function probe(url: string, token: string): number {
  const Libsql = createRequire(import.meta.url)("libsql") as new (p: string, o: Record<string, unknown>) => { prepare(s: string): { get(...a: unknown[]): { c?: number } | undefined } };
  const d = new Libsql(url, { authToken: token });
  return d.prepare("SELECT count(*) c FROM neurons").get()?.c ?? 0;
}
function humanError(err: unknown): string {
  const m = (err instanceof Error ? err.message : String(err)).toLowerCase();
  if (m.includes("401") || m.includes("unauthor") || m.includes("auth") || m.includes("jwt") || m.includes("invalid header") || m.includes("token"))
    return "the token was rejected — it's wrong or expired. Copy a fresh one from a device that already syncs (`cairn sync` prints it) or your Turso dashboard.";
  if (m.includes("timeout") || m.includes("connect") || m.includes("handshake") || m.includes("dns") || m.includes("resolve") || m.includes("unreachable"))
    return "couldn't reach the cloud — check the URL and your internet connection.";
  if (m.includes("no such table")) return "connected, but that database has no Cairn brain in it (wrong database URL?).";
  return err instanceof Error ? err.message : String(err);
}

// Best-effort: re-register the MCP server so its env matches config.json. config.json is the fallback
// anyway, but a stale registration env would otherwise win, so we keep them in lockstep. Non-fatal.
function reregister(env: Record<string, string> | null): void {
  const claude = Bun.which("claude");
  if (!claude) return;
  try { Bun.spawnSync([claude, "mcp", "remove", mcpName(), "--scope", "user"], { stdout: "ignore", stderr: "ignore" }); } catch { /* ignore */ }
  const envArgs = env ? Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]) : [];
  try { Bun.spawnSync([claude, "mcp", "add", mcpName(), "--scope", "user", ...envArgs, "--", bun(), SERVER], { stdout: "ignore", stderr: "ignore" }); } catch { /* ignore */ }
}

export async function sync(args: string[]): Promise<void> {
  const [a, b] = args;

  if (a === "off") {
    writeLibsql(null);
    reregister(null);
    line(`${sym.ok} ${c.green("Cloud sync turned off.")} Cairn now uses the local brain only.`);
    line(c.dim("   Restart Claude Code (or reconnect the cairn MCP server) to apply."));
    return;
  }

  if (!a) {
    const cfg = readLibsql();
    if (!cfg.url || !cfg.token) {
      line(`${sym.dot} Cloud sync is ${c.bold("off")} — Cairn is using the local brain only.`);
      line(`   Turn it on:  ${c.cyan("cairn sync <url> <token>")}`);
      line(c.dim("   Get <url> and <token> from your Turso dashboard, or run `cairn sync` on a device that already syncs to copy them."));
      return;
    }
    line(c.dim("Checking the cloud connection…"));
    try {
      const n = probe(cfg.url, cfg.token);
      line(`${sym.ok} ${c.green("Cloud sync is on and connected.")} ${c.bold(String(n))} memories.`);
    } catch (e) {
      line(`${sym.bad} ${c.red("Cloud sync is configured but NOT connecting:")} ${humanError(e)}`);
      process.exitCode = 1;
    }
    line("");
    line(c.dim("Connect another device — run this there:"));
    line(`  ${c.cyan(`cairn sync ${cfg.url} ${cfg.token}`)}`);
    return;
  }

  const url = a, token = b;
  if (!/^(libsql|https?|wss?):\/\//.test(url)) {
    line(`${sym.bad} ${c.red("That doesn't look like a database URL.")} Expected something like ${c.cyan("libsql://your-db.turso.io")}.`);
    process.exitCode = 1; return;
  }
  if (!token) {
    line(`${sym.bad} ${c.red("Missing token.")} Usage: ${c.cyan("cairn sync <url> <token>")}.`);
    process.exitCode = 1; return;
  }
  line(c.dim("Connecting to the cloud brain…"));
  let count: number;
  try { count = probe(url, token); }
  catch (e) {
    line(`${sym.bad} ${c.red("Could not connect — nothing was saved.")} ${humanError(e)}`);
    process.exitCode = 1; return;
  }
  writeLibsql({ url, token });
  reregister({ CAIRN_LIBSQL_URL: url, CAIRN_LIBSQL_TOKEN: token });
  line(`${sym.ok} ${c.green(c.bold("Connected to the shared cloud brain."))} ${c.bold(String(count))} memories — this device now syncs.`);
  line(c.dim(`   Saved to ${configPath().replace(/\\/g, "/")}.`));
  line(c.dim("   Restart Claude Code (or reconnect the cairn MCP server) to pick it up."));
  line(c.dim("   Add another device: run `cairn sync` here to copy the exact command."));
}
