# Security

## Reporting a vulnerability

Please don't open a public issue for a security problem.

Report it privately through GitHub's
[security advisories](https://github.com/czearing/cairn/security/advisories/new), or email the
maintainer listed on the GitHub profile. We aim to reply within 72 hours and will agree a fix and
disclosure timeline with you.

Include:

- What the issue is and what it lets an attacker do.
- Steps to reproduce. A minimal repro helps a lot.
- The version (`cairn --version`) and your OS.

## How the installer behaves

Cairn installs with a `curl ... | bash` (or `irm ... | iex`) one-liner that runs a script from this
repo. As with any installer of this kind, only run it from a source you trust, over HTTPS. You can
read the script first:

```bash
curl -fsSL https://raw.githubusercontent.com/czearing/cairn/main/scripts/install.sh
```

The installer writes to four places, and nothing else:

- `~/.claude/settings.json` (the hooks; it keeps a `.bak`)
- your user-scoped `claude mcp` registration
- a `cairn` shim in bun's bin directory
- the local brain under `~/.cairn/`

It never needs `sudo`. `cairn uninstall` reverses the hooks and the MCP registration.

## Planned

We plan to sign the installer and release artifacts (checksum plus Sigstore) so you can verify them
before they run.
