<div align="center">

<img src="assets/cairn.svg" width="96" alt="">

# Cairn

**Shared memory for AI coding agents.**

Markers left for whoever comes next.

[![CI](https://github.com/czearing/cairn/actions/workflows/ci.yml/badge.svg)](https://github.com/czearing/cairn/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![MCP](https://img.shields.io/badge/MCP-compatible-6E7A89.svg)](https://modelcontextprotocol.io)

[Install](#install) · [Usage](#usage) · [Tools](#tools) · [Commands](#commands) · [How it works](#how-it-works)

</div>

---

Every session starts from nothing. Your agent works out why the build breaks, you close the terminal,
and tomorrow it works it out again. Cairn keeps what it learned: a question, the answer, and links to
related questions. Agents search that graph by meaning before they start, so the second time you hit
a problem, the answer is already there.

It runs on your machine as a single SQLite file. No server, no account, no API key.

## Install

macOS, Linux, WSL2:

```bash
curl -fsSL https://raw.githubusercontent.com/czearing/cairn/main/scripts/install.sh | bash
```

Windows:

```powershell
irm https://raw.githubusercontent.com/czearing/cairn/main/scripts/install.ps1 | iex
```

The installer sets up [Bun](https://bun.sh) if you do not have it, registers Cairn with Claude Code
and GitHub Copilot CLI, downloads the embedding model, and stores and recalls a test memory to prove
it works. Restart your agent when it finishes.

Check it landed:

```bash
cairn doctor
```

To preview the changes without writing anything, run `cairn install --dry-run`. From a clone, run
`bun install && bun run install:claude`.

## Usage

There is nothing to call. Your agent gets the tools and a prompt that tells it to search before it
answers, so memory builds up as you work.

To see what it has written:

```bash
cairn ui
```

That serves a read-only view of the graph at `localhost:3737`. Every memory has its own link, so an
agent can point you straight at what it saved.

## Tools

Agents reach the graph over [MCP](https://modelcontextprotocol.io).

| Tool | What it does |
|---|---|
| `brain_search` | Finds memories by meaning, with the questions around each one. |
| `brain_create` | Saves a question and links it to related ones. |
| `brain_mutate` | Answers a question or edits its links. |
| `brain_delete` | Removes a memory. |

Cairn also learns reusable methods. When an agent works out a good way to do something, it saves the
steps and picks them up again next time through `skill_select`, `skill_create`, and `skill_edit`.

## Commands

| Command | What it does |
|---|---|
| `cairn doctor` | Checks your setup and prints how to fix what is missing. |
| `cairn verify` | Stores and recalls a memory in a throwaway database. |
| `cairn ui` | Serves the viewer. |
| `cairn update` | Updates to the latest version. |
| `cairn uninstall` | Removes the hooks and tool registration. Your memories stay. |

Run `cairn` on its own for the full list.

Cairn updates itself in the background about once an hour and leaves a checkout with uncommitted work
alone. Turn it off with `CAIRN_AUTO_UPDATE=0`.

## Other clients

For a tool that does not speak MCP, including local models through Ollama, run:

```bash
cairn proxy
```

It serves an OpenAI-compatible API on `localhost:11435/v1`. Point your client at it and Cairn adds
what it recalls to the system prompt on the way through. The model needs to know nothing about Cairn.

## How it works

The core is a graph of questions and answers with an embedding for each one. Nothing in it knows
about any particular agent. Two adapters connect it to the outside: an MCP server that exposes the
tools, and hooks that inject the prompts driving the search and answer loop.

```
prompts/   the injected prompts, plain markdown you can edit
src/core/  the graph: storage, embeddings, search
src/mcp/   the tools
src/inject/ and src/hosts/  the adapters for each agent
```

Settings are environment variables. `CAIRN_DB_PATH` sets where the database lives and
`CAIRN_EMBED_PROVIDER` swaps the embedding model for a hosted one.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md). Tests run with `bun test` from the repo root.

MIT licensed.
