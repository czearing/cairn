#!/usr/bin/env bash
# Cairn one-line installer (macOS/Linux).
#   curl -fsSL https://raw.githubusercontent.com/cairn-memory/cairn/main/scripts/install.sh | bash
set -euo pipefail
DIR="$HOME/.cairn/app"

if ! command -v bun >/dev/null 2>&1; then
  echo "Installing Bun..."
  curl -fsSL https://bun.sh/install | bash
  export PATH="$HOME/.bun/bin:$PATH"
fi

if [ -d "$DIR/.git" ]; then
  git -C "$DIR" pull --ff-only
else
  git clone --depth 1 https://github.com/cairn-memory/cairn "$DIR"
fi

cd "$DIR"
bun install
bun src/cli.ts install
