<div align="center">

<img src="assets/cairn.svg" width="80" alt="Cairn Logo">

# Cairn

**Persistent knowledge graph and planning engine for AI coding agents.**

[![CI](https://github.com/czearing/cairn/actions/workflows/ci.yml/badge.svg)](https://github.com/czearing/cairn/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![MCP](https://img.shields.io/badge/MCP-compatible-6E7A89.svg)](https://modelcontextprotocol.io)

[Installation](#quickstart) · [Core Architecture](#architecture) · [MCP Tools](#mcp-tools) · [CLI Commands](#cli-reference)

</div>

---

## Overview

AI coding agents normally start every session with amnesia—re-diagnosing previous bugs, re-discovering project conventions, and repeating expensive investigation work.

**Cairn** solves this by equipping agents with a local, zero-config semantic graph and strict verification engine. It captures questions, solutions, evidence, and dependencies directly as you work.

### Key Capabilities

- **Semantic Memory Graph**: Local vector embeddings (`sqlite-vec`) for fast context retrieval.
- **Pre-Edit Research Gate**: Requires agents to search prior knowledge and decompose tasks before altering code.
- **Execution & Plan Verification**: Interactive task checklists with verifiable completion gates.
- **100% Local & Private**: Embedded SQLite storage on your machine. Zero cloud accounts, zero telemetry leakage, zero API keys required.
- **Universal Host Support**: Native hooks and MCP protocols for GitHub Copilot CLI, Claude Code, and OpenAI-compatible proxies.

---

## Quickstart

### 1. One-Line Install

**macOS / Linux / WSL2:**
```bash
curl -fsSL https://raw.githubusercontent.com/czearing/cairn/main/scripts/install.sh | bash
```

**Windows (PowerShell):**
```powershell
irm https://raw.githubusercontent.com/czearing/cairn/main/scripts/install.ps1 | iex
```

The installer configures Bun (if needed), registers Cairn's MCP tools with your agent hosts, downloads the local embedding model, and verifies memory recall.

### 2. Verify Setup

```bash
cairn doctor
```

### 3. Visual Knowledge Graph

Launch the local interactive visualizer:

```bash
cairn ui
```
Opens a high-performance graph viewer at `http://localhost:3737`.

---

## MCP Tools

Cairn exposes standardized MCP tools directly to agent runtimes:

| Tool | Purpose |
| :--- | :--- |
| `brain_search` | Performs semantic search across prior discoveries and related graph questions. |
| `brain_create` | Declares an atomic question node linked into the knowledge graph. |
| `brain_mutate` | Answers a question node with citation-backed evidence or updates links. |
| `brain_delete` | Removes a specific node and detaches its graph edges. |
| `plan` / `contract` | Declares structured criteria and tracks verified completion in real time. |

---

## CLI Reference

```bash
cairn doctor      # Verify host registrations, SQLite vector engine, and dependencies
cairn verify      # Execute an end-to-end embedding and recall smoke test
cairn ui          # Start the local knowledge graph visualizer (localhost:3737)
cairn compact     # Reclaim fragmented SQLite storage and optimize vector indexes
cairn pref        # Manage global agent workflow preferences
cairn proxy       # Launch OpenAI-compatible proxy (localhost:11435/v1) for legacy tools
cairn update      # Pull latest updates and re-build local binaries
cairn uninstall   # Cleanly remove hooks and MCP registrations (preserves local database)
```

---

## Architecture

```
prompts/     # Concise, high-density workflow prompts and turn reminders
src/core/    # SQLite engine, vector embeddings, graph lifecycle, and telemetry
src/mcp/     # MCP server implementation and tool dispatch
src/hosts/   # Host integrations for GitHub Copilot CLI and Claude Code
src/ui/      # Interactive graph visualization dashboard
```

---

## License

MIT © [czearing](https://github.com/czearing)

Settings are environment variables. `CAIRN_DB_PATH` sets where the database lives and
`CAIRN_EMBED_PROVIDER` swaps the embedding model for a hosted one.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md). Tests run with `bun test` from the repo root.

MIT licensed.
