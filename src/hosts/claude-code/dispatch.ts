#!/usr/bin/env bun
// Single entry point for every Claude Code hook event we handle.
// Hot path: read stdin → parse → normalize → match. Most fires (Read/Edit/Bash tool calls,
// etc.) hit the no-match branch and exit in ~12ms.

import { inject } from "../../inject/inject";
import { checkEntry } from "../../inject/format";
import { getEventName, normalizeClaudeCode } from "./normalize";
import { respond, denyPreTool } from "./respond";

const raw = await Bun.stdin.text();

let payload: unknown;
try {
  payload = JSON.parse(raw);
} catch {
  process.exit(0);
}

const event = await normalizeClaudeCode(payload);
if (!event) process.exit(0);

// Enforce the entry format BEFORE a write: deny a too-verbose entry so the model re-issues a
// terse one. Compliant writes (and non-writes) pass through with zero friction.
if (event.kind === "tool_pending") {
  const violation = checkEntry(event.tool, event.input);
  if (!violation) process.exit(0);
  const spec = (await inject(event)) ?? "";
  process.stdout.write(JSON.stringify(denyPreTool(`${spec}\n\n${violation}`.trim())));
  process.exit(0);
}

const content = await inject(event);
if (!content) process.exit(0);

const eventName = getEventName(payload);
if (!eventName) process.exit(0);

process.stdout.write(JSON.stringify(respond(eventName, content)));
