# Contributing to Cairn

Thanks for helping mark the trail for whoever comes next.

## Dev setup

```bash
git clone https://github.com/czearing/cairn
cd cairn
bun install
```

## Running the checks

> [!IMPORTANT]
> **Run tests from the repo root.** `bunfig.toml` preloads `tests/setup.ts`, which redirects the
> tests onto a throwaway database. Bun reads `bunfig.toml` from the working directory, so running
> `bun test` from elsewhere skips that preload. (`src/core/db.ts` now hard-refuses to open the real
> brain during a test run as a backstop, but run from the root anyway.)

```bash
bun test            # core, MCP, hooks, installer, viewer
bunx tsc --noEmit   # typecheck
```

## Trying the installer safely

The brain at `~/.cairn/cairn.db` may be shared across agents. To exercise the installer end-to-end
(happy path, idempotent re-run, NO_COLOR, offline failure, uninstall) **without touching your real
settings, brain, or `claude mcp` registration**:

```bash
bun scripts/sandbox.ts          # asserts your live config/brain are byte-for-byte unchanged
bun src/cli.ts install --dry-run # read-only preview against your real config
```

## Architecture (where things live)

- `src/core/` — host-agnostic brain (db, embed, neurons, search). No host code here.
- `src/mcp/server.ts` — the MCP adapter (the `brain_*` tools).
- `src/inject/` + `src/hosts/<host>/` — prompt-injection adapters (Claude Code today).
- `prompts/` — hot-editable policy markdown; no rebuild needed.
- `scripts/` — installer bootstrap + the sandbox harness.

Adding support for a new host means adding a `src/hosts/<host>/` adapter — `src/core` and
`src/inject` don't change.

## Pull requests

1. Branch from `main`.
2. Keep changes focused; update the README/CHANGELOG when behavior changes.
3. Make sure `bun test` and `bunx tsc --noEmit` pass (CI runs them on Linux, macOS, and Windows).
4. Use clear commit messages ([Conventional Commits](https://www.conventionalcommits.org) preferred).

## License

By contributing you agree your contributions are licensed under the project's MIT license.
