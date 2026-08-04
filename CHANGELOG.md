# Changelog

This file follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- The brain could go permanently read-only on a machine, refusing every `brain_create`/`brain_mutate`
  /`brain_delete` with `brain is open read-only (CAIRN_READONLY=1)`. `CAIRN_READONLY` is a per-process
  *role*: the hooks set it on themselves because a hook only ever reads. But the hooks are exactly what
  spawn the long-lived writers — the engine daemon, the embed daemon and the auto-updater — and each was
  spawned with `{ ...process.env }`, so a reader handed its role to a writer that then served every
  session on the machine from a read-only connection. A shell that exports the flag did the same to the
  whole process tree, including the MCP server, which made it survive restarts and look like a
  configuration setting rather than a bug. Writers are now spawned through `writerEnv()`, which strips
  the role, and the two writer entry points (`engine-server`, the MCP server) claim the writer role
  before their first database open. `cairn doctor` now reports an exported `CAIRN_READONLY`.
- `brain_mutate` set edges in one direction only, so the Brain graph was systematically half-directed.
  `brain_create` mirrors every edge onto the peer to keep the graph undirected, but `mutate` replaced
  the source's edges without touching the peers — and `mutate ... edges` is the documented way to link
  a turn's nodes to a reused one. A link recorded that way was invisible from the peer, and a peer
  dropped from the list kept a dangling reverse edge pointing back at a node that no longer claimed it.
  Both directions are now updated together in a single transaction, and `mutate` returns the edges that
  were actually stored rather than the requested list.
- `brain_create` failed with `UNIQUE constraint failed: neurons.id` and lost the thought. The engine
  client mints the node id before it sends the request and retries every non-search operation when its
  2s request timeout expires, so a slow embed left the original attempt still running when its own
  retry arrived. Both layers guarding against that were check-then-act with an `await` in the gap: the
  daemon remembered only *settled* responses, so an in-flight request looked absent, and `neurons`
  checked `get(id)` before the embed and inserted after it. Two copies of one create therefore cleared
  both checks and raced to the same primary key. Creation now claims the id atomically with
  `ON CONFLICT(id) DO NOTHING` and the loser reads back the winner's row, so a duplicate delivery
  yields the one node both callers asked for instead of an error — this also covers the cross-process
  race between the daemon and a client that fell back to in-process work, which no cache can see. The
  request cache now stores the in-flight promise, so a retry joins its original rather than re-running
  it, and a rejected request is evicted so one transient failure is not cached permanently.

- Quality rates spoke for a release that had been superseded for days, and its long-repaired outage
  held the banner at OUTAGE. A minimum sample of 20 runs was used to *select* which release supplied
  the rates, so when no release met it — and under a release per commit none does, since recent
  releases get 3 to 4 runs each — selection fell through to `ORDER BY COUNT(*) DESC` and pinned to the
  largest sample, which is always the oldest. The stale release's visibility failures then combined
  with an absolute `visibilityFailures > 0` outage trigger to make the verdict unfixable by shipping a
  fix: no amount of healthy new runs could displace it. Sample size is now a disclosure rather than a
  gate — the newest release with comparable completed runs supplies the rates, and a thin sample is
  reported as `N completed run(s) of M in the window` with an explicit issue — and the outage trigger
  is a rate (`CAIRN_OUTAGE_VISIBILITY_RATE`, default 25%) so one stray failure degrades a release
  instead of declaring a total outage. Per-release scoping is unchanged, so a repaired release still
  cannot be dragged down by an older one's faults.

- A read-only investigation was classified as a code-changing turn by its own scratch file, tripling
  the brain-node floor it had to clear. Reading data a native tool cannot reach — querying the
  telemetry SQLite database, for example — requires writing a probe script, running it, and deleting
  it, and `Out-File`/`Remove-Item` matched the shell-mutation pattern. The turn was then blocked for
  having 2 nodes against a floor of 3 despite a complete search, answers, citations and root synthesis,
  and the only way to clear a quantity floor is to create another node, so the gate built to protect
  recall pushed toward padded ones — the same pressure `5d5e439` removed for reuse. The fail-closed
  action gate still treats such a command as a side effect, so an unfinished workflow cannot smuggle
  edits through a temp file; only the decomposition floor now ignores writes that the same command
  deletes or that live in a scratch location. This restores the behavior the scaled floor already
  documented, that "read-only shell probes and views do not count".

- Release comparisons discarded a whole run whenever a single Cairn tool call failed to report its
  runtime release. Missing attribution was treated as proof that the hook and runtime releases
  differed, so runs that were in fact wholly served by one release were thrown away and comparable
  runs collapsed toward zero, leaving no quality claim falsifiable. A run is now excluded only on
  positive evidence of a different release; a run whose Cairn calls carry no runtime identity is
  reported separately as unattributed instead of being counted as mixed, and a run that never called a
  Cairn tool stays comparable because it has no runtime to disagree with. On the live 7-day sample this
  moves coherent runs from 2 to 3 and mixed runs from 4 to 2 without dropping any release comparison.

- Behavior rates picked the newest release with any completed run, even when every one of that
  release's runs was release-mismatched, so the report showed `comparable runs 0` immediately after
  each publish while a perfectly usable older sample sat unused. Rates now prefer the newest release
  that has a comparable sample, falling back to any completed sample so a brand-new release still
  reports.

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
