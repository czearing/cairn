# Changelog

This file follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Automatic updates. Each install fast-forwards itself to the published release at most once an hour
  and reapplies the installer, so a fix reaches you without running `cairn update`. The check is local
  file I/O, so hooks never wait on the network, and a dirty or diverged checkout is left alone.
  Disable with `CAIRN_AUTO_UPDATE=0`.
- `cairn proxy`, an OpenAI-compatible gateway that recalls memory into the system prompt and forwards
  to a model backend. Works with Ollama, OpenAI, or any OpenAI-compatible server.

### Fixed

- The brain could become permanently read-only on a machine, refusing every write. Hooks mark
  themselves read-only, but they also spawn the long-lived writers, which inherited that role. Writers
  now start with it stripped, and `cairn doctor` reports an exported `CAIRN_READONLY`.
- `brain_mutate` recorded edges in one direction, so a link was invisible from the other node. Both
  directions are now written together, and the call returns the edges actually stored.
- `brain_create` could fail with a duplicate id and lose the thought when a slow embedding let a retry
  overlap the original request. Creation now claims the id atomically and a retry joins the request
  already in flight.
- Quality rates could speak for a release that had been superseded for days, keeping a repaired outage
  on the banner. Sample size is now a disclosure rather than a gate, and the outage trigger is a rate
  instead of a single failure.
- A read-only investigation was counted as a code-changing turn because it wrote and deleted a
  temporary probe script, raising the bar it had to clear.
- Release comparisons discarded an entire run when a single tool call did not report its version. Runs
  are now excluded only on positive evidence of a mismatch, and unattributed runs are reported
  separately.
- Behavior rates now prefer the newest release that has a comparable sample, instead of reporting zero
  right after a publish.
- The submission gate counted only nodes a turn created, so correctly reusing an existing answer could
  never satisfy it. Reuse now counts.
- Receipt quality could import a retired checker's verdicts when several runs were recorded in the
  same millisecond, inflating the reported step counts.
- Tests no longer leave SQLite files behind in the repository root.

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
