#!/usr/bin/env bun
// Single entry point for every Claude Code hook event we handle.
// Hot path: read stdin → parse → normalize → match. Most fires (Read/Edit/Bash tool calls,
// etc.) hit the no-match branch and exit in ~12ms.

import { inject } from "../../inject/inject";
import { getEventName, normalizeClaudeCode } from "./normalize";
import { respond, denyPreTool } from "./respond";
import { rootId, openBranchExists } from "../../core/audit";

const isBrainCreate = (t: string) => t === "brain_create" || t.endsWith("__brain_create");

const raw = await Bun.stdin.text();

let payload: unknown;
try {
  payload = JSON.parse(raw);
} catch {
  process.exit(0);
}

const event = await normalizeClaudeCode(payload);
if (!event) process.exit(0);

// Depth-first gate: a new node that links ONLY to the root is denied while open branches
// remain. Finish (or descend) an open branch before starting another straight off the root.
if (event.kind === "tool_pending" && isBrainCreate(event.tool)) {
  const edges = Array.isArray(event.input.edges) ? (event.input.edges as string[]) : [];
  const root = rootId();
  if (root && edges.length > 0 && edges.every((e) => e === root) && openBranchExists()) {
    process.stdout.write(JSON.stringify(denyPreTool(
      "The root already has open branches. Link this under one of them and go deeper, or finish an open branch first. Do not add another node straight off the root."
    )));
    process.exit(0);
  }
}

const content = await inject(event);
if (!content) process.exit(0);

// Reward depth, not count: praise a new node ONLY when it was linked under a non-root parent
// (genuine descent). Flat root-children earn no praise.
let out = content;
if (event.kind === "tool_completed" && isBrainCreate(event.tool)) {
  const edges = Array.isArray(event.input.edges) ? (event.input.edges as string[]) : [];
  const root = rootId();
  if (root && edges.some((e) => e !== root)) {
    out = "And you went a level deeper, exactly the move. Keep splitting downward.\n" + content;
  }
}

const eventName = getEventName(payload);
if (!eventName) process.exit(0);

process.stdout.write(JSON.stringify(respond(eventName, out)));
