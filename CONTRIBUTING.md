# Contributing

Thanks for helping out.

## Setup

```bash
git clone https://github.com/czearing/cairn
cd cairn
bun install
```

## Checks

> [!IMPORTANT]
> Run tests from the repo root. `bunfig.toml` preloads `tests/setup.ts`, which points the tests at a
> throwaway database. Bun reads `bunfig.toml` from the current directory, so running `bun test` from
> somewhere else skips that preload. (`src/core/db.ts` also refuses to open the real brain during a
> test run, as a backstop. Run from the root anyway.)

```bash
bun test            # core, MCP, hooks, installer, viewer
bunx tsc --noEmit   # typecheck
```

## Trying the installer

The brain at `~/.cairn/cairn.db` may be shared by several agents. To exercise the installer without
touching your real settings, brain, or MCP registration:

```bash
bun scripts/sandbox.ts           # checks your real config and brain are unchanged afterward
bun src/cli.ts install --dry-run # preview the changes, writing nothing
```

## Where things live

- `src/core/` is the brain: db, embeddings, neurons, search. No host code goes here.
- `src/mcp/server.ts` is the MCP adapter (the `brain_*` tools).
- `src/inject/` and `src/hosts/<host>/` are the prompt-injection adapters. Claude Code is the only
  host today.
- `prompts/` is editable policy. No rebuild needed.
- `scripts/` holds the installer bootstrap and the sandbox.

To support a new host, add a `src/hosts/<host>/` adapter. The core and the inject layer stay the same.

## Pull requests

1. Branch from `main`.
2. Keep the change focused. Update the README and CHANGELOG when behavior changes.
3. Make sure `bun test` and `bunx tsc --noEmit` pass. CI runs them on Linux, macOS, and Windows.
4. Write clear commit messages. [Conventional Commits](https://www.conventionalcommits.org) preferred.

Contributions are licensed under the project's MIT license.
