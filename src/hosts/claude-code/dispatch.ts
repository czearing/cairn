#!/usr/bin/env bun
// Single entry point for every Claude Code hook event we handle.
// Hot path: read stdin → parse → normalize → match. Most fires (Read/Edit/Bash tool calls,
// etc.) hit the no-match branch and exit in ~12ms.
//
// A hook must NEVER fail the user's turn. The brain is read from a separate short-lived process
// while the long-lived MCP server may hold the same SQLite file, so a read can occasionally throw
// (a transient lock, a cloud-sync hiccup, a malformed transcript). All of that is swallowed here:
// on any error we emit nothing and exit 0, so Claude Code never shows a "non-blocking status code"
// error for a harmless, recoverable miss. The explicit final exit(0) also stops a libSQL background
// sync timer from keeping this process alive (which, in cloud mode, would otherwise hang until the
// hook times out).

import { inject } from "../../inject/inject";
import { getEventName, normalizeClaudeCode } from "./normalize";
import { respond, denyPreTool } from "./respond";
import { rootId, openBranchExists, isClosedQuestion } from "../../core/audit";

// Hooks only READ the brain (audit + injection), so declare read-only before the first db() open.
// db() then opens the brain with bun:sqlite read-only — never a syncing libSQL connection — so every
// fire stays a fast, lock-free local read even when the brain is a cloud-synced replica. (db() reads
// this lazily, so setting it here, before main() calls into the brain, is enough.)
process.env.CAIRN_READONLY = "1";

const isBrainCreate = (t: string) => t === "brain_create" || t.endsWith("__brain_create");

// Awaited write so the buffer is fully flushed before we force-exit (a bare process.exit() right
// after process.stdout.write() can truncate piped output).
const emit = (obj: object) => Bun.write(Bun.stdout, JSON.stringify(obj));

async function main(): Promise<void> {
  const raw = await Bun.stdin.text();

  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return;
  }

  const event = await normalizeClaudeCode(payload);
  if (!event) return;

  // Depth-first gate: a new node that links ONLY to the root is denied while open branches
  // remain. Finish (or descend) an open branch before starting another straight off the root.
  if (event.kind === "tool_pending" && isBrainCreate(event.tool)) {
    const text = typeof event.input.text === "string" ? event.input.text : "";
    if (isClosedQuestion(text)) {
      await emit(denyPreTool(
        "That is a yes/no question. It presumes its answer and cannot be split. Re-ask it as a how or why question, then create it."
      ));
      return;
    }
    const edges = Array.isArray(event.input.edges) ? (event.input.edges as string[]) : [];
    const root = rootId();
    if (root && edges.length > 0 && edges.every((e) => e === root) && openBranchExists()) {
      await emit(denyPreTool(
        "The root already has open branches. Link this under one of them and go deeper, or finish an open branch first. Do not add another node straight off the root."
      ));
      return;
    }
  }

  const content = await inject(event);
  if (!content) return;

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
  if (!eventName) return;

  await emit(respond(eventName, out));
}

try {
  await main();
} catch (err) {
  // Set CAIRN_HOOK_DEBUG=1 to surface what failed; otherwise stay silent so the turn isn't disrupted.
  if (process.env.CAIRN_HOOK_DEBUG) console.error("[cairn hook]", err instanceof Error ? err.stack : err);
}
process.exit(0);
