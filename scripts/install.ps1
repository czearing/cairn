# Cairn one-line installer (Windows).
#   irm https://raw.githubusercontent.com/czearing/cairn/main/scripts/install.ps1 | iex
$ErrorActionPreference = "Stop"
$dir = Join-Path $HOME ".cairn\app"

try {
  Write-Host "Cairn -> installing for Claude Code"

  if (-not (Get-Command bun -ErrorAction SilentlyContinue)) {
    Write-Host "  - Bun not found - installing it first..."
    irm bun.sh/install.ps1 | iex
  }

  if (Test-Path (Join-Path $dir ".git")) {
    Write-Host "  - Updating Cairn..."
    git -C $dir pull --ff-only
  } else {
    Write-Host "  - Fetching Cairn..."
    git clone --depth 1 https://github.com/czearing/cairn $dir
  }

  Push-Location $dir
  try {
    Write-Host "  - Installing dependencies..."
    bun install --silent
    # Hand off to the rich installer: preflight -> hooks -> MCP -> warm model -> verify -> summary.
    bun src/cli.ts install
  } finally {
    Pop-Location
  }
}
catch {
  Write-Host ""
  Write-Host "x Install failed: $($_.Exception.Message)"
  Write-Host "  -> Re-run, or report it: https://github.com/czearing/cairn/issues"
  exit 1
}
