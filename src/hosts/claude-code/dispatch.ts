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

// Fired once per turn (PreToolUse) if needed.
const COMPLETION_REMINDER =
  "Ensure you completed every requested task.";
const CAIRN_VISIBILITY_REMINDER =
  "Cairn's required brain tools were not visible in this session. The host may have cached an earlier MCP startup failure. Do not retry unavailable tools or block the user's task; finish it and clearly report the Cairn quality outage so the MCP connection can be restarted.";

// Awaited write so the buffer is fully flushed before we force-exit (a bare process.exit() right
// after process.stdout.write() can truncate piped output).
const emit = (obj: object) => Bun.write(Bun.stdout, JSON.stringify(obj));

async function main(): Promise<void> {
  // Imported here, not at top level, so a module that fails to load is caught by the guard below
  // rather than crashing the process before it can exit cleanly.
  const { inject } = await import("../../inject/inject");
  const { getEventName, normalizeClaudeCode } = await import("./normalize");
  const { respond, denyPreTool } = await import("./respond");
  const { rootId, openBranchExists } = await import("../../core/audit");

  const raw = await Bun.stdin.text();

  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return;
  }
  let hostEventKey = "";
  try {
    const { recordHostEvent } = await import("../../core/host-events");
    hostEventKey = recordHostEvent(
      "claude",
      String((payload as { hook_event_name?: unknown }).hook_event_name ?? ""),
      raw,
      payload
    );
  } catch { /* event indexing never blocks the host */ }
  const payloadSession = String((payload as { session_id?: unknown }).session_id ?? "");
  const qualityEventKey = hostEventKey || `${payloadSession}:${String((payload as { hook_event_name?: unknown }).hook_event_name ?? "")}`;
  const observedContext = async (source: string, text: string): Promise<string> => {
    try {
      const { recordTelemetry } = await import("../../core/telemetry");
      recordTelemetry({
        kind: "context",
        source,
        host: "claude",
        sessionId: payloadSession,
        contextChars: text.length,
        eventKey: hostEventKey ? `${hostEventKey}:${source}` : undefined,
      });
    } catch { /* telemetry never blocks the host */ }
    return text;
  };

  // Subagent lifecycle: SessionStart injects the workflow prompt.
  const hookName = (payload as { hook_event_name?: unknown }).hook_event_name;
  if (hookName === "SessionStart") {
    const content = await inject({ kind: "user_message", text: "" });
    if (content) await emit(respond("SessionStart", await observedContext("session-start", content)));
    return;
  }

  if (hookName === "SubagentStop") return;

  const event = await normalizeClaudeCode(payload);
  if (!event) return;

  // Depth-first gate: a new node that links ONLY to the root is denied while open branches
  // remain. Finish (or descend) an open branch before starting another straight off the root.
  if (event.kind === "tool_pending" && isBrainCreate(event.tool)) {
    const edges = Array.isArray(event.input.edges) ? (event.input.edges as string[]) : [];
    const root = rootId();
    if (root && edges.length > 0 && edges.every((e) => e === root) && openBranchExists()) {
      await emit(denyPreTool(
        "The root already has open branches. Link this under one of them and go deeper, or finish an open branch first. Do not add another node straight off the root."
      ));
      return;
    }
  }

  let turnSeq = 0;
  if (event.kind === "user_message") {
    try {
      const { lifecycleScope, resetLifecycle, readLifecycle } = await import("../../core/lifecycle");
      const scope = lifecycleScope("claude", payloadSession);
      resetLifecycle(scope);
      turnSeq = readLifecycle(scope).turnSeq;
      event.turnSeq = turnSeq;
    } catch { /* lifecycle tracking is best-effort */ }
  }

  const stopHookActive = hookName === "Stop" && (payload as { stop_hook_active?: unknown }).stop_hook_active === true;
  let content = stopHookActive ? null : await inject(event);
  if (hookName === "Stop" && !stopHookActive && process.env.CAIRN_ENFORCE_STOP_GATES === "0") {
    content = `${CAIRN_VISIBILITY_REMINDER}\n${COMPLETION_REMINDER}`;
  }

  // Reward depth, not count: praise a new node ONLY when it was linked under a non-root parent
  // (genuine descent). Flat root-children earn no praise.
  let out = content ?? "";
  if (content && event.kind === "tool_completed" && isBrainCreate(event.tool)) {
    const edges = Array.isArray(event.input.edges) ? (event.input.edges as string[]) : [];
    const root = rootId();
    if (root && edges.some((e) => e !== root)) {
      out = "And you went a level deeper, exactly the move. Keep splitting downward.\n" + content;
    }
  }

  try {
    const telemetry = await import("../../core/telemetry");
    const { lifecycleScope, readLifecycle } = await import("../../core/lifecycle");
    const scope = lifecycleScope("claude", payloadSession);
    if (!turnSeq) {
      const life = readLifecycle(scope);
      turnSeq = life.turnSeq;
    }

    if (event.kind === "user_message") {
      try { (await import("../../core/auto-update")).maybeAutoUpdate(); }
      catch { /* self-update is background work and never blocks a turn */ }
      telemetry.beginTelemetryRun({
        host: "claude", sessionId: payloadSession, turnSeq,
        promptHash: telemetry.promptFingerprint(content || ""),
        injectedChars: content?.length || 0,
        model: String((payload as { model?: unknown }).model ?? ""),
      });
    } else if (event.kind === "tool_completed") {
      telemetry.recordTelemetryTool({
        host: "claude", sessionId: payloadSession, turnSeq,
        eventKey: qualityEventKey, toolName: event.tool, args: event.input,
        result: event.output, success: telemetry.telemetryResultSucceeded(event.output),
        durationMs: Number((payload as { duration_ms?: unknown }).duration_ms ?? 0),
      });
    } else if (event.kind === "turn_finished") {
      telemetry.finishTelemetryRun({
        host: "claude", sessionId: payloadSession, turnSeq,
        completed: true, workflowPassed: Boolean(event.usedBrain),
        brainUsed: event.usedBrain, stopNudges: 0,
      });
    }
  } catch { /* quality telemetry never blocks the host */ }

  if (!out) return;
  const eventName = getEventName(payload);
  if (!eventName) return;

  await emit(respond(eventName, await observedContext(`${hookName}:${event.kind}`, out)));
}

try {
  await main();
} catch (err) {
  // Set CAIRN_HOOK_DEBUG=1 to surface what failed; otherwise stay silent so the turn isn't disrupted.
  if (process.env.CAIRN_HOOK_DEBUG) console.error("[cairn hook]", err instanceof Error ? err.stack : err);
}
process.exit(0);
