# Cairn

[![CI](https://github.com/czearing/cairn/actions/workflows/ci.yml/badge.svg)](https://github.com/czearing/cairn/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

Cairn is a shared, persistent memory for AI agents. It stores each idea as a *neuron*: a question,
its answer, and links to related neurons. Agents read and write it over [MCP](https://modelcontextprotocol.io)
and recall past thinking by meaning, so work builds on itself instead of starting over.

It is a memory layer, not an agent. There is no service to run. You get a local SQLite database,
three MCP tools, and a prompt-injection layer that nudges the agent to search before it answers.

## Install

```bash
# macOS, Linux, WSL2
curl -fsSL https://raw.githubusercontent.com/czearing/cairn/main/scripts/install.sh | bash
```
```powershell
# Windows
irm https://raw.githubusercontent.com/czearing/cairn/main/scripts/install.ps1 | iex
```

The installer checks your environment, wires Cairn into Claude Code, downloads the local embedding
model, and runs a quick round-trip to prove the brain works before it finishes. It also adds a
global `cairn` command, so day to day you just type `cairn doctor` or `cairn verify`. Restart Claude
Code afterward to load the tools.

From a clone, run `bun install && bun run install:claude`.

To update later, run `cairn update`. It pulls the latest code, reinstalls, and reapplies the config.

## Commands

| Command | What it does |
|---|---|
| `cairn doctor` | Checks your environment and prints how to fix anything missing. |
| `cairn verify` | Creates and recalls a memory in a throwaway database to confirm it works. |
| `cairn update` | Updates to the latest version and reapplies the config. |
| `cairn uninstall` | Removes the hooks and MCP registration. Your saved memories stay. |
| `cairn install --dry-run` | Shows what install would change, without writing anything. |
| `cairn --version` | Prints the installed version. |

## The tools

Agents use three tools over MCP:

| Tool | Args | What it does |
|---|---|---|
| `brain_search` | `query` | Finds relevant neurons by meaning and returns each one with its connected subgraph. |
| `brain_create` | `text`, `edges?` | Adds a neuron and returns its id. |
| `brain_mutate` | `id`, `text?`, `answer?`, `edges?` | Updates a neuron. Setting `answer` marks it solved. |

## How it fits together

The brain itself knows nothing about Claude Code. Two adapters connect them:

- The **MCP server** exposes the three tools to any MCP host (Claude Code, Cursor, VS Code, and more).
- **Hooks** fire on Claude Code's lifecycle events and inject prompts that drive a
  decompose, research, answer loop.

```
prompts/                 editable policy, one markdown file per moment
src/
  core/                  the brain (db, embeddings, neurons, search). No host code.
  mcp/server.ts          the three tools, over core
  inject/                events, matchers, dispatch
  hosts/claude-code/     the Claude Code adapter
scripts/                 installer bootstrap and the sandbox harness
```

## Memory for any model (the proxy)

Not every tool speaks MCP. For a local model like Ollama, or any OpenAI-compatible client, run the
proxy instead:

```bash
cairn proxy
```

It serves an OpenAI-compatible API on `http://localhost:11435/v1`. Point your client's `base_url` at
it. On each chat request, the proxy searches the brain with your latest message and adds what it
finds to the system prompt, then forwards the request to the model. The model needs to know nothing
about Cairn.

Switch the backend with one variable:

```bash
CAIRN_PROXY_UPSTREAM=ollama cairn proxy        # default, http://localhost:11434/v1
CAIRN_PROXY_UPSTREAM=openai cairn proxy         # needs OPENAI_API_KEY
CAIRN_PROXY_BASE_URL=http://host:1234/v1 cairn proxy   # any other OpenAI-compatible server
```

To see it work without a model running:

```bash
bun scripts/proxy-demo.ts
```

The proxy recalls memory (read) today. Writing new memories back from a conversation is opt-in and
still minimal, because the brain is a curated graph of questions and answers, not a chat log.

## Configuration

Everything is set with environment variables. There are no config files to find.

| Variable | Default | Purpose |
|---|---|---|
| `CAIRN_DB_PATH` | `~/.cairn/cairn.db` | Where the local brain lives. |
| `CAIRN_LIBSQL_URL` | none | Turso primary `libsql://…` URL. Set together with the token to sync the brain across devices (see below). |
| `CAIRN_LIBSQL_TOKEN` | none | Auth token for the Turso primary. |
| `CAIRN_LIBSQL_LOCAL` | `~/.cairn/cairn-replica.db` | Local replica file used in sync mode, kept separate from the local-only brain. |
| `CAIRN_LIBSQL_SYNC_PERIOD` | `60` | Seconds between automatic background pulls from the primary. |
| `CAIRN_EMBED_PROVIDER` | `local` | `local` runs MiniLM in process; `openai` calls an API. |
| `CAIRN_EMBED_MODEL` | provider default | For example, `text-embedding-3-small`. |
| `CAIRN_EMBED_API_KEY` | none | For the `openai` provider. |
| `CAIRN_EMBED_BASE_URL` | OpenAI | For Azure or other OpenAI-compatible endpoints. |
| `CAIRN_RELEVANCE_THRESHOLD` | `0.3` | How similar a neuron must be to count as relevant. |
| `CAIRN_RELATIVE_FLOOR` | `0.7` | Adaptive relevance gate: keep results scoring `>= max(threshold, top × this)` for the query. At `0.7` a dense query is trimmed to its strongest cluster while a narrow query still returns its answer. `0` disables it. |
| `CAIRN_SEARCH_LIMIT` | `0` (off) | Optional top-N count cap on the `brain_search` MCP tool, as a backstop on top of the relevance floor. `0` lets the floor alone decide. |
| `CAIRN_PROXY_UPSTREAM` | `ollama` | Which model backend the proxy forwards to (`ollama`, `openai`). |
| `CAIRN_PROXY_BASE_URL` | preset | Override the upstream URL for any OpenAI-compatible server. |
| `CAIRN_PROXY_PORT` | `11435` | Port the proxy listens on. |
| `CAIRN_PROXY_MEMORIES` | `5` | How many recalled neurons to inject per request. |

Swap the embedding model by changing these. No code change.

## Sync across devices (Turso)

By default the brain is a single local SQLite file. To share one brain across machines, point Cairn at
a free [Turso](https://turso.tech) database and it runs as a **libSQL embedded replica**: reads stay
local and fast, writes go straight to the cloud primary, and other devices' changes are pulled in the
background. No server to run, and it falls back to the local replica when offline.

1. In the [Turso dashboard](https://app.turso.tech), create a database and copy its URL, then create a token.
2. Set both variables wherever Cairn runs (your MCP host's `env`, or your shell):

   ```bash
   CAIRN_LIBSQL_URL=libsql://your-db.turso.io
   CAIRN_LIBSQL_TOKEN=your-token
   ```
3. To move an existing local brain into the cloud once, run:

   ```bash
   CAIRN_LIBSQL_URL=… CAIRN_LIBSQL_TOKEN=… bun scripts/migrate-to-turso.ts
   ```

**Adding another device:** export the same two variables and run `cairn install` (or
`bun run install:claude`). The installer bakes them into the Claude Code and Copilot MCP
registrations for you — no config files to hand-edit. The new machine pulls the existing brain from
the cloud on first use; don't re-run the migrate script there.

With the variables unset, nothing changes — Cairn stays a local-only `bun:sqlite` brain. The local
file at `CAIRN_DB_PATH` is left untouched as a backup; sync uses a separate replica file.

### Cost and the Turso free plan

Reads never touch the network — every search runs against the local replica — so they don't count
against Turso's quota at all. Only writes (new/edited neurons) and `sync()` pulls do. The free plan's
500M rows-read / 10M rows-written per month is far more than a personal brain needs. The one knob that
affects cost is `CAIRN_LIBSQL_SYNC_PERIOD`: every pull costs a little even when nothing changed, so
the default 60s is the economical choice — lower it only if you need faster cross-device freshness.

## Trying it safely

The brain is a live database that several agents may share. To rehearse the full installer (happy
path, re-run, offline failure, uninstall) without touching your real settings, brain, or MCP
registration, run the sandbox:

```bash
bun scripts/sandbox.ts
```

It points every side effect at a temp directory and then checks that your real `settings.json` and
brain are unchanged.

## Editing prompts

The injected prompts are plain markdown in `prompts/`. Edit one and the next hook picks it up. No
rebuild, no restart. To add a case, drop in a new `.md` and add a matcher in `src/inject/matchers.ts`.

| Prompt | Fires on |
|---|---|
| `user-message.md` | every user message |
| `search-results.md` | after `brain_search` |
| `node-created.md` | after `brain_create` |
| `subtask-spawned.md` | after a sub-agent task |

## Subagents and agent teams

`cairn install` also writes a `cairn` subagent definition to `~/.claude/agents/cairn.md`. Spawn a
subagent — or an agent-team teammate — with that type and it runs under the **same** injected prompts:
its frontmatter hooks call the same dispatcher (a `SessionStart` injects the workflow, search/create calls
get the same state-specific reminders, and its `Stop` becomes `SubagentStop` for the completion gate), while its
body carries the policy for the agent-teams path. Subagents already inherit the `brain_*` MCP tools,
so they read and grow the same shared brain you do.

## Adding a host

1. Make `src/hosts/<host>/`.
2. Write `normalize.ts` to turn the host's payload into a `NormalizedEvent`.
3. Write `dispatch.ts` to wire stdin to normalize to inject to stdout.
4. Add an installer path. The core does not change.

## Develop

```bash
bun test        # core, MCP, hooks, installer, viewer. Run from the repo root.
bun run mcp     # run the MCP server over stdio
bun run ui      # serve the viewer at http://localhost:3737
bun run seed    # write a few demo neurons
```

See [CONTRIBUTING.md](./CONTRIBUTING.md) before you open a PR.

## Viewer

`cairn ui` serves a small read-only view of the brain, with a link per neuron at `/node/<id>`. The
MCP tools return that link for every neuron, so an agent can hand you a clickable reference to what
it wrote. It is optional and separate from the rest.

MIT licensed.
