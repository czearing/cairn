# Cairn

[![CI](https://github.com/czearing/cairn/actions/workflows/ci.yml/badge.svg)](https://github.com/czearing/cairn/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

> Markers left for whoever comes next.

A shared, persistent, **semantic-graph memory** for AI agents. Each entry is a *neuron* — a
question and its answer — linked to related neurons. Agents read and write it over MCP and
**recall** prior thinking by meaning, so work compounds instead of repeating.

No UI, no service to run. Just a local database, three MCP tools, and a prompt-injection layer
that drives a decompose → research → answer loop.

## What's in the box

```
prompts/              POLICY — hot-editable markdown, one per scenario
src/
├── core/             the brain (host-agnostic)
│   ├── config.ts     env-driven config (db path, model, threshold)
│   ├── db.ts         bun:sqlite connection + schema
│   ├── embed.ts      embedding provider (local default, API opt-in)
│   ├── neurons.ts    create / mutate / remove / get / all
│   └── search.ts     semantic search + full-subgraph traversal
├── mcp/server.ts     the three tools, over core
├── inject/           events · matchers · inject  (the dispatcher)
└── hosts/            per-agent adapters
    └── claude-code/  normalize · dispatch
scripts/install.ts    one command: hooks + MCP registration
```

**Policy lives in `prompts/` and `matchers.ts`; plumbing lives in `hosts/`.** Swapping Claude
Code for another agent only touches `src/hosts/`.

## Install

One line — it installs Bun if missing, fetches Cairn, and runs the full setup:

```bash
# macOS / Linux / WSL2
curl -fsSL https://raw.githubusercontent.com/czearing/cairn/main/scripts/install.sh | bash
```
```powershell
# Windows
irm https://raw.githubusercontent.com/czearing/cairn/main/scripts/install.ps1 | iex
```

From a clone it's just `bun install && bun run install:claude`. Either way you get a global **`cairn`**
command (a shim dropped into bun's on-PATH bin dir), so afterwards you just type `cairn doctor`,
`cairn verify`, `cairn update`, etc. — no `bun path/to/cli.ts`.

**Update** any time with `cairn update` (git pull + reinstall + idempotent re-apply, printing the
old→new commit), or just re-run the one-liner.

The installer runs **six measured phases** — it doesn't just say "done", it *proves* the brain works:

1. **Preflight** — checks Bun, Git, the Claude CLI, and write access; prints the exact fix for anything missing.
2. **Hooks** — merges Cairn's four hooks into `~/.claude/settings.json` (idempotent; `.bak` on first change).
3. **MCP** — registers the `brain_*` tools at user scope, detecting an existing registration so re-runs are no-ops.
4. **Warm** — downloads/loads the local embedding model *now*, so your first search is instant (not a hidden stall later).
5. **Verify** — runs a real create→recall→delete round-trip in a throwaway DB and reports the timing.
6. **Summary** — what changed, where the brain lives, and one next step.

Restart Claude Code afterward to pick up the tools and injected prompts.

| Command | Does |
|---|---|
| `cairn doctor` | Environment preflight; prints a fix for anything missing. |
| `cairn verify` | Proves the brain works end-to-end in an isolated DB. |
| `cairn install --dry-run` | Runs the real preflight and prints what install *would* change — writes nothing. |
| `cairn update` | Pulls the latest source, reinstalls deps, re-applies config; prints old→new commit. |
| `cairn uninstall` | Removes Cairn's hooks and MCP registration (your brain DB is left intact). |

### Testing the installer safely

The brain is a shared, live database. To rehearse the full installer UX — happy path, idempotent
re-run, `NO_COLOR`/non-TTY rendering, an offline failure, and uninstall — without touching your real
settings, brain, or `claude mcp` registration:

```bash
bun scripts/sandbox.ts
```

It redirects every side effect to a temp dir (`CAIRN_SETTINGS_PATH`, `CAIRN_DB_PATH`, `CAIRN_SKIP_MCP`)
and asserts your live `settings.json` and brain are byte-for-byte unchanged afterward. To rehearse the
real `claude mcp` path under a throwaway name, set `CAIRN_MCP_NAME=cairn-sandbox`.

## The three tools

| Tool | Args | Does |
|---|---|---|
| `brain_search` | `query` | Semantic search. Returns every relevant neuron + the whole connected subgraph of each hit, ranked, no limit. |
| `brain_create` | `text`, `edges?` | Create a neuron; returns its id. |
| `brain_mutate` | `id`, `text?`, `answer?`, `edges?` | Update a neuron. Setting `answer` marks it solved. |

## Configuration (all env vars)

| Var | Default | Purpose |
|---|---|---|
| `CAIRN_DB_PATH` | `~/.cairn/cairn.db` | Where the brain lives |
| `CAIRN_EMBED_PROVIDER` | `local` | `local` (in-process MiniLM) or `openai` |
| `CAIRN_EMBED_MODEL` | provider default | e.g. `text-embedding-3-small` |
| `CAIRN_EMBED_API_KEY` | — | for the `openai` provider |
| `CAIRN_EMBED_BASE_URL` | OpenAI | for Azure / OpenAI-compatible endpoints |
| `CAIRN_RELEVANCE_THRESHOLD` | `0.3` | similarity bar for "relevant" |

Swap the embedding model with **no code change** — just set the env vars.

## Editing prompts

Edit the markdown in `prompts/`. No rebuild, no restart — the next hook fire reads the new
content. To add a scenario, drop a new `.md` and add a case to `src/inject/matchers.ts`.

| Prompt | Fires on |
|---|---|
| `user-message.md` | every user message |
| `search-results.md` | after `brain_search` |
| `node-created.md` | after `brain_create` |
| `node-modified.md` | after `brain_mutate` |
| `subtask-spawned.md` | after a `Task` (sub-agent) |

## Adding a host

1. `mkdir src/hosts/<host>/`
2. Write `normalize.ts` producing a `NormalizedEvent` from the host's payload.
3. Write `dispatch.ts` wiring stdin → normalize → inject → stdout.
4. Add an installer path. The core (`inject/`) doesn't change.

## Develop

```bash
bun test                 # core contracts + semantic eval + MCP + viewer
bun run mcp              # run the MCP server over stdio
bun run ui               # serve the viewer (default http://localhost:3737)
bun run seed             # optional demo data
```

## Viewer

`cairn ui` (or `bun run ui`) serves a tiny read-only view of the brain from `~/.cairn/cairn.db`,
deep-linkable per neuron at `/node/<id>`. The MCP tools return a `url` field for every neuron,
so an agent can hand back a clickable link to what it created. Configure with `CAIRN_UI_PORT`
/ `CAIRN_UI_URL`. It's optional and entirely separate from the MCP/inject core.

MIT licensed.
