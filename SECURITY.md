# Security Policy

## Reporting a vulnerability

Please **do not open a public issue** for security vulnerabilities.

Instead, report privately via GitHub's [Security Advisories](https://github.com/czearing/cairn/security/advisories/new)
(Security → Report a vulnerability), or email the maintainer listed on the GitHub profile. We aim to
acknowledge within 72 hours and will coordinate a fix and disclosure timeline with you.

## What to include

- A description of the issue and its impact.
- Steps to reproduce (a minimal repro is ideal).
- The affected version (`cairn --version`) and OS.

## Scope & trust model

Cairn installs via a `curl … | bash` / `irm … | iex` one-liner that runs code from this repository.
As with any such installer, **only run it from a source you trust over HTTPS.** You can always read
the script first:

```bash
curl -fsSL https://raw.githubusercontent.com/czearing/cairn/main/scripts/install.sh   # inspect, then run
```

The installer writes only to `~/.claude/settings.json` (hooks, with a `.bak`), your user-scoped
`claude mcp` registration, a `cairn` shim in bun's bin dir, and the local brain at `~/.cairn/`.
It never requires `sudo`. `cairn uninstall` reverses the hooks and MCP registration.

## Roadmap

We plan to publish a checksum + Sigstore signature for the installer and release artifacts so the
one-liner can be cryptographically verified before it runs.
