# Changelog

This file follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

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
