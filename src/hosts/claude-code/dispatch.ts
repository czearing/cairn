#!/usr/bin/env bun
// Single entry point for every Claude Code hook event we handle.
// Hot path: read stdin → parse → normalize → match. Most fires (Read/Edit/Bash tool calls,
// etc.) hit the no-match branch and exit in ~12ms.
//
// A hook must NEVER fail the user's turn. The brain is read from a separate short-lived process
// while the long-lived MCP server may hold the same SQLite file, so something can throw (a transient
// lock, a cloud-sync hiccup, a malformed transcript) — even at *import* time (a native module that
// won't load). Everything below runs inside one try/catch, including the module imports themselves
// (done dynamically), so on any failure we emit nothing and exit 0. Claude Code therefore never shows
// a "non-blocking status code" error for a harmless, recoverable miss. The explicit final exit(0)
// also stops a libSQL background sync timer from keeping this process alive.

// Read-only before the first brain open: hooks only READ (audit + injection), so db() opens the brain
// with bun:sqlite read-only — never a syncing libSQL connection — keeping every fire fast and
// lock-free even when the brain is a cloud-synced replica.
process.env.CAIRN_READONLY = "1";

const isBrainCreate = (t: string) => t === "brain_create" || t.endsWith("__brain_create");

// Awaited write so the buffer is fully flushed before we force-exit (a bare process.exit() right
// after process.stdout.write() can truncate piped output).
const emit = (obj: object) => Bun.write(Bun.stdout, JSON.stringify(obj));

async function main(): Promise<void> {
  // Imported here, not at top level, so a module that fails to load is caught by the guard below
  // rather than crashing the process before it can exit cleanly.
  const { inject } = await import("../../inject/inject");
  const { getEventName, normalizeClaudeCode } = await import("./normalize");
  const { respond, denyPreTool } = await import("./respond");
  const { rootId, openBranchExists, isClosedQuestion } = await import("../../core/audit");

  const raw = await Bun.stdin.text();

  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return;
  }

  // Subagent lifecycle: a spawned subagent runs this same dispatch via its definition's frontmatter
  // hooks, so it gets the identical injected prompts. Two events need mapping. SessionStart is the
  // subagent's first-prompt moment (UserPromptSubmit never fires for a subagent), so inject the same
  // workflow prompt the main agent gets. A subagent's Stop arrives as SubagentStop — treat it exactly
  // like Stop so the same record/split-leaves enforcement runs (the response shape is identical).
  const hookName = (payload as { hook_event_name?: unknown }).hook_event_name;
  if (hookName === "SessionStart") {
    const content = await inject({ kind: "user_message", text: "" });
    if (content) await emit(respond("SessionStart", content));
    return;
  }
  if (hookName === "SubagentStop") (payload as { hook_event_name?: string }).hook_event_name = "Stop";

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

  // Skill layer, ON by default (set CAIRN_SKILLS=0 to disable). On a user message, append the curated-steps
  // injection for the matching skill(s); on turn end, fire background learning. Best-effort and isolated so
  // it can never disrupt the turn, and it does no work until skills exist.
  if (process.env.CAIRN_SKILLS !== "0") {
    try {
      const { skillInject, skillLearn } = await import("../../skill/hook");
      if (event.kind === "user_message") { const add = await skillInject(event.text); if (add) out = `${out}\n\n${add}`; }
      else if (event.kind === "turn_finished") skillLearn((payload as { transcript_path?: string }).transcript_path);
    } catch { /* skills are best-effort */ }
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
