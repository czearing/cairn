# Cairn

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

```bash
bun install
bun run install:claude   # appends hooks to ~/.claude/settings.json + registers the MCP server
```

The installer is idempotent and writes a `.bak` of `settings.json` on first change. Restart
Claude Code afterward to pick up the `brain_*` tools and the injected prompts.

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
