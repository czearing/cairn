# Changelog

All notable changes to Cairn are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project aims to adhere to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Re-engineered, verified installer: six measured phases (preflight → hooks → MCP → warm model →
  end-to-end smoke test → summary) that *prove* the brain works before declaring success.
- Composable commands: `cairn doctor`, `cairn verify`, `cairn update`, `cairn uninstall`,
  `cairn install --dry-run`, and `cairn --version`.
- Global `cairn` command installed as a shim in bun's on-PATH bin dir (no PATH edits; avoids the
  unreliable `bun link` on Windows).
- `scripts/sandbox.ts`: a safe harness to rehearse the full installer UX against temp paths,
  asserting the live config/brain are byte-for-byte unchanged.
- Test-safety guard in `src/core/db.ts` that refuses to open the real brain during a test run.
- Cross-platform CI (Linux/macOS/Windows), `SECURITY.md`, `CONTRIBUTING.md`.

### Fixed
- Reconciled the install/update/docs repository URL to `github.com/czearing/cairn` (the advertised
  one-liner previously pointed at a non-existent repo).

[Unreleased]: https://github.com/czearing/cairn/commits/main
