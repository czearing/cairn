# Changelog

This file follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- The Copilot submission gate counted only nodes a turn *created*, so a turn that correctly reused an
  existing answered node could never satisfy it. Agents were blocked repeatedly and told they had
  "recorded nothing to the brain", which pushed them into creating duplicate nodes for work the graph
  already held — the opposite of the instruction to reuse prior work. A turn now completes either by
  creating and resolving its decomposition or by adopting existing nodes, proven by mutating a node its
  own search returned, and reused nodes count toward the decomposition minimum. The reminder names the
  real state instead of claiming nothing was recorded.

### Added

- Automatic updates. Every install now fast-forwards itself to the published release in a detached
  background worker at most once an hour, then reapplies the idempotent installer, so a shipped fix
  reaches users without anyone running `cairn update`. The turn-side check is local file I/O only, so
  hooks never wait on git or the network, and a dirty or diverged checkout is never modified. Disable
  with `CAIRN_AUTO_UPDATE=0` or `"autoUpdate": false` in `~/.cairn/config.json`; `cairn doctor`
  reports the last check and its outcome.
- `cairn proxy`: an OpenAI-compatible gateway that recalls memory into the system prompt and forwards
  to a model backend. Works with Ollama (default), OpenAI, or any OpenAI-compatible server. Switch
  the backend with `CAIRN_PROXY_UPSTREAM` or `CAIRN_PROXY_BASE_URL`. See `scripts/proxy-demo.ts`.

## [0.1.0] - 2026-06-05

First public release.

### Added

- A verified installer. It checks your environment, wires Cairn into Claude Code, registers the MCP
  server, warms the embedding model, and runs a create-recall round-trip before it finishes.
- Commands: `cairn doctor`, `cairn verify`, `cairn update`, `cairn uninstall`,
  `cairn install --dry-run`, and `cairn --version`.
- A global `cairn` command, installed as a shim in bun's bin directory.
- `scripts/sandbox.ts`, which rehearses the installer against temp paths and checks your real config
  and brain are unchanged.
- A test guard in `src/core/db.ts` that refuses to open the real brain during a test run.
- CI on Linux, macOS, and Windows. `SECURITY.md` and `CONTRIBUTING.md`.

### Fixed

- The install and update commands pointed at a repository that did not exist. They now point at
  `github.com/czearing/cairn`.

[Unreleased]: https://github.com/czearing/cairn/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/czearing/cairn/releases/tag/v0.1.0
