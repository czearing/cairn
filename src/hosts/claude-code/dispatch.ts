#!/usr/bin/env bun
// Single entry point for every Claude Code hook event we handle.
// Hot path: read stdin → parse → normalize → match. Most fires (Read/Edit/Bash tool calls,
// etc.) hit the no-match branch and exit in ~12ms.

import { inject } from "../../inject/inject";
import { getEventName, normalizeClaudeCode } from "./normalize";

const raw = await Bun.stdin.text();

let payload: unknown;
try {
  payload = JSON.parse(raw);
} catch {
  process.exit(0);
}

const event = await normalizeClaudeCode(payload);
if (!event) process.exit(0);

const content = await inject(event);
if (!content) process.exit(0);

const eventName = getEventName(payload);
if (!eventName) process.exit(0);

// Stop hooks force continuation via decision/reason; other events add context.
const out =
  eventName === "Stop"
    ? { decision: "block", reason: content }
    : { hookSpecificOutput: { hookEventName: eventName, additionalContext: content } };

process.stdout.write(JSON.stringify(out));
