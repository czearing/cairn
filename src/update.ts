import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { c, sym, line, step } from "./term";

// `cairn update` — pull the latest source, reinstall deps, and re-apply the (idempotent) installer.
// Prints previous→new commit so a revert is possible (rclone/wp-cli self-update pattern). Falls back
// to the one-liner when this isn't a git checkout (e.g. a downloaded tarball).

const ROOT = resolve(import.meta.dir, "..");
const ONELINER = "curl -fsSL https://raw.githubusercontent.com/czearing/cairn/main/scripts/install.sh | bash";

const git = () => Bun.which("git");
const text = (b: Uint8Array) => new TextDecoder().decode(b).trim();
function sh(cmd: string[], cwd = ROOT) {
  return Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
}
function head(): string {
  const g = git();
  if (!g) return "?";
  const r = sh([g, "-C", ROOT, "rev-parse", "--short", "HEAD"]);
  return r.success ? text(r.stdout) : "?";
}

export async function update(): Promise<void> {
  line(c.bold("\nUpdating Cairn\n"));
  const g = git();
  if (!g || !existsSync(join(ROOT, ".git"))) {
    step(`${sym.warn} This install isn't a git checkout — update by re-running the one-liner:`);
    step(`    ${c.cyan(ONELINER)}`);
    process.exitCode = 1;
    return;
  }

  const before = head();
  step(c.dim(`current ${before} — pulling latest…`));
  const pull = sh([g, "-C", ROOT, "pull", "--ff-only"]);
  if (!pull.success) {
    step(`${sym.bad} ${c.red("git pull failed.")} ${c.dim(text(pull.stderr).split("\n")[0] ?? "")}`);
    step(`    ${sym.arrow} Resolve local changes in ${c.cyan(ROOT.replace(/\\/g, "/"))} and retry ${c.cyan("cairn update")}.`);
    process.exitCode = 1;
    return;
  }

  const after = head();
  if (before === after) {
    step(`${sym.ok} Already up to date ${c.dim(`(${after})`)}.`);
  } else {
    step(`${sym.ok} Updated ${c.dim(before)} ${sym.arrow} ${c.bold(after)}. Installing dependencies…`);
    sh([(Bun.which("bun") ?? "bun"), "install"]);
  }

  // Re-apply hooks / MCP / global command idempotently and re-verify.
  line(c.dim("\nRe-applying configuration…"));
  await (await import("./install")).install();
}
