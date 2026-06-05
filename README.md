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

## Configuration

Everything is set with environment variables. There are no config files to find.

| Variable | Default | Purpose |
|---|---|---|
| `CAIRN_DB_PATH` | `~/.cairn/cairn.db` | Where the brain lives. |
| `CAIRN_EMBED_PROVIDER` | `local` | `local` runs MiniLM in process; `openai` calls an API. |
| `CAIRN_EMBED_MODEL` | provider default | For example, `text-embedding-3-small`. |
| `CAIRN_EMBED_API_KEY` | none | For the `openai` provider. |
| `CAIRN_EMBED_BASE_URL` | OpenAI | For Azure or other OpenAI-compatible endpoints. |
| `CAIRN_RELEVANCE_THRESHOLD` | `0.3` | How similar a neuron must be to count as relevant. |

Swap the embedding model by changing these. No code change.

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
| `node-modified.md` | after `brain_mutate` |
| `subtask-spawned.md` | after a sub-agent task |

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
