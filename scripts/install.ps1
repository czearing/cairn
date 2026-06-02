# Cairn one-line installer (Windows).
#   irm https://raw.githubusercontent.com/cairn-memory/cairn/main/scripts/install.ps1 | iex
$ErrorActionPreference = "Stop"
$dir = Join-Path $HOME ".cairn\app"

if (-not (Get-Command bun -ErrorAction SilentlyContinue)) {
  Write-Host "Installing Bun..."
  irm bun.sh/install.ps1 | iex
}

if (Test-Path $dir) {
  git -C $dir pull --ff-only
} else {
  git clone --depth 1 https://github.com/cairn-memory/cairn $dir
}

Push-Location $dir
try {
  bun install
  bun src/cli.ts install
} finally {
  Pop-Location
}
