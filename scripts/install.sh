#!/usr/bin/env bash
# Cairn one-line installer (macOS/Linux/WSL2).
#   curl -fsSL https://raw.githubusercontent.com/czearing/cairn/main/scripts/install.sh | bash
set -euo pipefail
DIR="$HOME/.cairn/app"

# Rewrite any failure into a human next step instead of a bare stack trace (clig.dev).
trap 'echo ""; echo "✗ Install failed. Re-run, or report it with the line above:"; echo "  → https://github.com/czearing/cairn/issues"; exit 1' ERR

echo "Cairn → installing for Claude Code"

if ! command -v bun >/dev/null 2>&1; then
  echo "  • Bun not found — installing it first…"
  curl -fsSL https://bun.sh/install | bash
  export PATH="$HOME/.bun/bin:$PATH"
fi

if [ -d "$DIR/.git" ]; then
  echo "  • Updating Cairn…"
  git -C "$DIR" pull --ff-only
else
  echo "  • Fetching Cairn…"
  git clone --depth 1 https://github.com/czearing/cairn "$DIR"
fi

cd "$DIR"
echo "  • Installing dependencies…"
bun install --silent

# Hand off to the rich installer: preflight → hooks → MCP → warm model → verify → summary.
exec bun src/cli.ts install
