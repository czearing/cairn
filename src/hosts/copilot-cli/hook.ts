#!/usr/bin/env bun
// GitHub Copilot CLI hooks for Cairn. argv[2] selects the mode, one per hook event registered by
// setup.ts. As of Copilot CLI v1.0.66 the hook surface is much wider than the original two events,
// so Cairn now reaches near-parity with Claude Code (see docs.github.com/.../hooks-reference):
//
//   user-prompt    (userPromptSubmitted) : inject the workflow and reset the per-turn latch.
//   session-start  (sessionStart)        : legacy fallback used only when the installer detects a Copilot
//                                          version that cannot deliver userPromptSubmitted context.
//   pre-tool       (preToolUse)          : gate a brain_create (deny closed-question / root-only-branch).
//                                          preToolUse has no additionalContext channel, so entry-format.md /
//                                          orchestrate.md cannot be injected here — only allow/deny/modify.
//   post-tool      (postToolUse)         : after a brain_* or Task tool, inject the matching reminder and
//                                          record brain/skill usage.
//   agent-stop     (agentStop)           : the Stop equivalent — decision:"block" forces another turn until
//                                          workflow and completion gates pass.
//   subagent-start (subagentStart)       : additionalContext is PREPENDED to the subagent's own prompt —
//                                          the one channel that reaches a subagent's window (subagent-protocol.md).
//
// Per-event context on PreToolUse remains unreachable; the brain_create gate enforces the format intent instead.
import { readFile } from "node:fs/promises";
import { Database } from "bun:sqlite";
import {
  appendFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isSystemEnvelope } from "../../skill/noise";
import { recordHostEvent } from "../../core/host-events";
import {
  beginTelemetryRun,
  finishTelemetryRun,
  promptFingerprint,
  recordTelemetry,
  recordTelemetryState,
  recordTelemetryTool,
} from "../../core/telemetry";
import { formatSkillCatalog, selectedSkillBlock, skillCatalogSnapshot, skillIdsFromTask } from "../../skill/catalog";
import {
  claimDelegation,
  lifecycleScope,
  readLifecycle,
  registerDelegation,
  releaseDelegation,
  resetLifecycle,
  updateLifecycle,
} from "../../skill/lifecycle";
import { skillResultId } from "../../skill/tool-result";
import { postToolPromptFiles } from "../../inject/post-tool";

const PROMPTS = new URL("../../../prompts/", import.meta.url);
let emittedUsage: Parameters<typeof recordTelemetry>[0] | undefined;
const emit = (obj: object) => {
  const output = obj as { additionalContext?: unknown; reason?: unknown };
  const context = typeof output.additionalContext === "string"
    ? output.additionalContext
    : typeof output.reason === "string" ? output.reason : "";
  if (context && emittedUsage) recordTelemetry({ ...emittedUsage, contextChars: context.length });
  process.stdout.write(JSON.stringify(obj));
};
export const internalContext = (text: string): string => text ? `<cairn-internal>\n${text}\n</cairn-internal>` : "";
const COMPLETION_REMINDER = "Before submitting, ensure you have completed every requested task. Finish anything still incomplete now.";
const CAIRN_VISIBILITY_REMINDER =
  "Before submitting, attempt the injected Cairn brain and skill workflow now. If Cairn tools are unavailable in this session, do not retry or block on them; finish the user's task.";

// Read stdin but NEVER block the host indefinitely. `Bun.stdin.text()` only resolves on EOF, so if the
// CLI invokes a hook without closing its stdin (observed on some Copilot/Claude CLI versions, and for
// events that carry no tool-input payload) the hook would hang forever — and since the host runs hooks
// synchronously and waits for their JSON, that hang freezes the whole agent. Racing against a timeout
// makes a slow/never-closed stdin degrade to an empty payload (fail-open) instead of a freeze.
const STDIN_TIMEOUT_MS = Number(process.env.CAIRN_HOOK_STDIN_TIMEOUT_MS || "1500");
const readStdin = async (): Promise<string> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Bun.stdin.text(),
      new Promise<string>((resolve) => {
        timer = setTimeout(() => resolve(""), STDIN_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};
const promptText = async (file: string): Promise<string> => {
  try {
    return (await readFile(new URL(file, PROMPTS), "utf8")).trim();
  } catch {
    return "";
  }
};
const promptWithCatalog = async (file: string): Promise<string> => {
  const base = await promptText(file);
  try { return `${base}\n\n${formatSkillCatalog()}`; }
  catch { return base; }
};
const workflowPrompt = (): Promise<string> => promptWithCatalog("user-message.md");
const catalogVersion = (): string => {
  try { return skillCatalogSnapshot().version; }
  catch { return ""; }
};

// MCP tools arrive server-prefixed ("cairn-brain_search") or bare/namespaced ("brain_search" /
// "mcp__cairn__brain_search"); accept any of those forms.
export const isTool = (name: string, want: string): boolean =>
  name === want || name.endsWith(want) || name.includes(want);
const isNativeSkillTool = (name: string): boolean => {
  const normalized = name.toLowerCase();
  return normalized === "skill" || normalized.endsWith("__skill");
};
const isCairnMcpTool = (name: string): boolean => [
  "brain_search", "brain_create", "brain_mutate", "brain_delete",
  "skill_select", "skill_create", "skill_search", "skill_load", "skill_edit",
].some((tool) => isTool(name, tool));
const isTask = (name: string): boolean => /^(task|agent)$/i.test(name) || name === "Task" || name === "Agent";

// ── Pure decision helpers (exported for unit tests) ────────────────────────────────────────────

// Which state-specific prompt files a completed tool earns, in delivery order. The per-turn workflow and
// tool schemas already carry invariant write rules, so search/create receive only their new next-step delta.
export function postToolFiles(toolName: string, answer: string): string[] {
  return postToolPromptFiles(toolName, answer);
}

// Whether agentStop should force another turn, and with which prompt. Bounded to STOP_CAP nudges per
// turn so a stubborn agent can never be looped forever (Copilot sends no stop_hook_active flag).
export const STOP_CAP = 2;
export function stopDecision(s: { brainUsed: boolean; skillUsed: boolean; stopNudges: number }): {
  file: string;
} {
  if (s.stopNudges >= STOP_CAP) return { file: "" };
  if (!s.skillUsed) return { file: "skill-search-reminder.md" };
  if (!s.brainUsed) return { file: "turn-reminder.md" };
  return { file: "" };
}

// Whether a pending brain_create must be denied (preToolUse). Mirrors the Claude dispatch gate: a node
// linked ONLY to the root while open branches remain is rejected (a structural graph fact, not a content
// judgment). Dependencies are injected so this is pure and DB-free in tests.
export function gateDecision(
  toolName: string,
  args: Record<string, unknown>,
  ctx: { rootId: string | null; openBranch: boolean }
): { deny: boolean; reason?: string } {
  if (!isTool(toolName, "brain_create")) return { deny: false };
  const edges = Array.isArray(args.edges) ? (args.edges as string[]) : [];
  if (ctx.rootId && edges.length > 0 && edges.every((e) => e === ctx.rootId) && ctx.openBranch)
    return {
      deny: true,
      reason:
        "The root already has open branches. Link this under one of them and go deeper, or finish an open branch first. Do not add another node straight off the root.",
    };
  return { deny: false };
}

const turnScope = (sessionId: string, agentId = "") => lifecycleScope("copilot", sessionId, agentId);

// ── stdin payload parsing (camelCase config ⇒ camelCase payloads; snake_case tolerated) ─────────
const safeJson = (s: string): unknown => {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
};
const toolResultSucceeded = (result: unknown): boolean => {
  if (!result || typeof result !== "object") return true;
  const value = result as { success?: unknown; isError?: unknown; resultType?: unknown };
  if (value.success === false || value.isError === true) return false;
  return value.resultType == null || value.resultType === "success";
};
interface Payload {
  sessionId: string;
  agentId: string;
  agentName: string;
  toolName: string;
  args: Record<string, unknown>;
  result: unknown;
  transcriptPath: string;
  prompt: string;
  eventId: string;
  toolCallId: string;
  durationMs: number;
}
function parsePayload(raw: string): Payload {
  try {
    const j = JSON.parse(raw) as Record<string, unknown>;
    const firstCall = Array.isArray(j.toolCalls) && j.toolCalls[0] && typeof j.toolCalls[0] === "object"
      ? j.toolCalls[0] as Record<string, unknown>
      : undefined;
    const rawArgs = j.toolArgs ?? j.tool_input ?? firstCall?.args;
    const args = (typeof rawArgs === "string" ? safeJson(rawArgs) : rawArgs) as Record<string, unknown> | undefined;
    return {
      sessionId: (j.sessionId as string) ?? (j.session_id as string) ?? "",
      agentId: (j.agentId as string) ?? (j.agent_id as string) ?? "",
      agentName: (j.agentName as string) ?? (j.agent_name as string) ?? "",
      toolName: (j.toolName as string) ?? (j.tool_name as string) ?? (firstCall?.name as string) ?? "",
      args: args ?? {},
      result: j.toolResult ?? j.tool_result ?? j.toolOutput ?? j.tool_output,
      transcriptPath: (j.transcriptPath as string) ?? (j.transcript_path as string) ?? "",
      prompt: (j.prompt as string) ?? "",
      eventId: j.timestamp == null ? "" : String(j.timestamp),
      toolCallId: (j.toolCallId as string) ?? (j.tool_call_id as string) ?? (firstCall?.id as string) ?? "",
      durationMs: Number(j.durationMs ?? j.duration_ms ?? 0),
    };
  } catch {
    return { sessionId: "", agentId: "", agentName: "", toolName: "", args: {}, result: undefined, transcriptPath: "", prompt: "", eventId: "", toolCallId: "", durationMs: 0 };
  }
}

export const shouldStartUserTurn = (prompt: string): boolean =>
  !isSystemEnvelope(prompt);
const isToolCallSession = (sessionId: string): boolean => sessionId.startsWith("call_");

export function harnessTurnDeferred(
  dbPath = process.env.CAIRN_HARNESS_DB || "",
  agent = process.env.CAIRN_HARNESS_AGENT || ""
): boolean {
  if (!dbPath || !agent) return false;
  try {
    const database = new Database(dbPath, { readonly: true });
    try {
      const latest = database.query(`SELECT status FROM tasks WHERE assignee=?
        AND (status='waiting' OR claimed_at IS NOT NULL OR completed_at IS NOT NULL)
        ORDER BY COALESCE(completed_at,claimed_at,created_at) DESC LIMIT 1`)
        .get(agent) as { status?: string } | null;
      return latest?.status === "waiting";
    } finally {
      database.close();
    }
  } catch {
    return false;
  }
}

function debugLog(mode: string, raw: string): void {
  if (!process.env.CAIRN_HOOK_DEBUG) return;
  try {
    appendFileSync(join(tmpdir(), "cairn-copilot-hook.log"), `[${mode}] ${raw.slice(0, 300)}\n`);
  } catch {
    /* debug only */
  }
}

// ── Mode dispatch (only runs when executed directly, so tests can import the helpers above) ─────
async function main(): Promise<void> {
  // The skill learner runs the brain's own CLI headlessly (`copilot -p` / `claude -p`). When THAT is a
  // copilot subprocess it re-fires these hooks — which would inject the workflow into the learner and, worse,
  // let a legacy learner's own agentStop re-enter Cairn. The learner sets
  // CAIRN_SKILL_WORKER=1, which copilot passes down to its hook processes, so we short-circuit every mode to a
  // no-op here. This mirrors the Claude path's `claude -p --setting-sources project` isolation.
  if (process.env.CAIRN_SKILL_WORKER === "1") return void emit({});
  // Hooks only ever READ the brain (gate + audit); open it read-only so a short-lived fire never
  // contends with the long-lived MCP server's writer. Set here (not at module scope) so importing the
  // pure helpers above for tests never flips a shared process's DB to read-only.
  process.env.CAIRN_READONLY = "1";
  const mode = process.argv[2];
  const raw = await readStdin();
  debugLog(mode ?? "", raw);
  const rawPayload = safeJson(raw);
  let hostEventKey = "";
  try { hostEventKey = recordHostEvent("copilot", mode ?? "", raw, rawPayload); } catch { /* event indexing never blocks the host */ }
  const { sessionId, agentId, agentName, toolName, args, result, transcriptPath, prompt, eventId, toolCallId, durationMs } = parsePayload(raw);
  let turnSeq = 0;
  try { turnSeq = readLifecycle(turnScope(sessionId, agentId)).turnSeq; } catch { /* telemetry is optional */ }
  const usageSource = `${mode || "hook"}${toolName ? `:${toolName}` : ""}`;
  emittedUsage = {
    kind: "context",
    source: usageSource,
    host: "copilot",
    sessionId,
    turnSeq,
    eventKey: hostEventKey ? `${hostEventKey}:${usageSource}` : undefined,
  };

  if (mode === "session-start") {
    const text = await workflowPrompt();
    emit(text ? { additionalContext: internalContext(text) } : {});
    return;
  }
  if (mode === "subagent-start") {
    const text = await promptText("subagent-protocol.md");
    emit(text ? { additionalContext: internalContext(text) } : {});
    return;
  }

  if (mode === "subagent-stop") {
    const { latestCopilotAgentId } = await import("../../skill/review-queue");
    const stoppingAgentId = agentId || latestCopilotAgentId(transcriptPath, agentName);
    const stateId = turnScope(sessionId, stoppingAgentId);
    resetLifecycle(stateId, { brainUsed: true, skillUsed: true });
    emit({});
    return;
  }

  if (mode === "user-prompt") {
    // TURN-START injection, exactly like Claude Code's UserPromptSubmit: emit the full workflow so it is
    // in front of the model BEFORE it acts, on EVERY prompt — this is what keeps it from decaying or being
    // dropped on compaction. Empirically verified on Copilot CLI v1.0.66: userPromptSubmitted additionalContext
    // IS delivered to the model (the published hooks reference says "Output processed: No", but a live marker
    // test proved otherwise). This is the only main-agent workflow injection point so the first turn cannot
    // receive a duplicate sessionStart copy.
    // Also reset the per-turn latch so the agentStop gate is scoped to this turn.
    //
    // Internal stop continuations are filtered by shouldStartUserTurn and preserve the existing state.
    // Every genuine prompt starts a fully fresh budget; preserving only exhausted nudges while clearing
    // skill/brain usage would let a resumed Harness task bypass both gates.
    const stateId = turnScope(sessionId);
    const delegatedIds = claimDelegation(sessionId, stateId);
    if (delegatedIds.length) {
      const state = resetLifecycle(stateId, { brainUsed: true, skillUsed: true });
      beginTelemetryRun({
        host: "copilot", sessionId, turnSeq: state.turnSeq, promptHash: "",
        catalogVersion: catalogVersion(), injectedChars: 0,
      });
      return void emit({});
    }
    // Built-in/custom subagents use their host-owned tool-call id as sessionId. Some launch paths do not
    // expose the parent preToolUse event, so no delegation row exists to claim. They still must not receive
    // the main-agent workflow; the parent owns skill maintenance.
    if (isToolCallSession(sessionId)) {
      const state = resetLifecycle(stateId, { brainUsed: true, skillUsed: true });
      const protocol = await promptText("subagent-protocol.md");
      beginTelemetryRun({
        host: "copilot", sessionId, turnSeq: state.turnSeq,
        promptHash: promptFingerprint(protocol), catalogVersion: catalogVersion(),
        injectedChars: internalContext(protocol).length,
      });
      return void emit(protocol ? { additionalContext: internalContext(protocol) } : {});
    }
    if (!shouldStartUserTurn(prompt)) return void emit({});
    const state = resetLifecycle(stateId);
    if (emittedUsage) emittedUsage.turnSeq = state.turnSeq;
    const wf = await workflowPrompt();
    beginTelemetryRun({
      host: "copilot", sessionId, turnSeq: state.turnSeq,
      promptHash: promptFingerprint(wf), catalogVersion: catalogVersion(),
      injectedChars: internalContext(wf).length,
    });
    emit(wf ? { additionalContext: internalContext(wf) } : {});
    return;
  }

  if (mode === "pre-tool") {
    // preToolUse command hooks are FAIL-CLOSED (a crash denies the tool), so default to allow and only
    // ever deny on an explicit gate match.
    if (process.env.CAIRN_COPILOT_NO_GATE) return void emit({});
    let decision: { deny: boolean; reason?: string } = { deny: false };
    try {
      if (isTask(toolName) && typeof args.prompt === "string") {
        const parentScope = turnScope(sessionId, agentId);
        const selectedIds = readLifecycle(parentScope).pendingReviewIds.filter((id) => !id.startsWith("__"));
        const requestedIds = skillIdsFromTask(args);
        const skillIds = requestedIds.filter((id) => selectedIds.includes(id));
        if (skillIds.length) {
          registerDelegation(parentScope, toolCallId, skillIds);
          const protocol = await promptText("delegated-skill-protocol.md");
          emit({ modifiedArgs: { ...args, prompt: `${protocol}\n\n${selectedSkillBlock(skillIds)}\n\n${args.prompt}` } });
          return;
        }
      }
      if (isTask(toolName) && args.agent_type === "general-purpose" && typeof args.prompt === "string") {
        const protocol = await promptWithCatalog("general-purpose-protocol.md");
        emit({ modifiedArgs: { ...args, prompt: `${protocol}\n${args.prompt}` } });
        return;
      }
      if (isTool(toolName, "brain_create")) {
        const { rootId, openBranchExists } = await import("../../core/audit");
        decision = gateDecision(toolName, args, {
          rootId: rootId(),
          openBranch: openBranchExists(),
        });
      }
    } catch {
      decision = { deny: false };
    }
    emit(decision.deny ? { permissionDecision: "deny", permissionDecisionReason: decision.reason } : {});
    return;
  }

  if (mode === "post-tool") {
    // Record brain usage for the turn-end gate: brain_search/brain_mutate mark the turn as "used the brain".
    const stateId = turnScope(sessionId, agentId);
    const state = updateLifecycle(stateId, (current) => {
      const next = { ...current };
      const succeeded = toolResultSucceeded(result);
      if (isCairnMcpTool(toolName)) next.cairnToolAttempted = true;
      if (isCairnMcpTool(toolName) && succeeded) next.cairnToolObserved = true;
      if ((isTool(toolName, "brain_search") || isTool(toolName, "brain_mutate")) && succeeded) next.brainUsed = true;
      if (isNativeSkillTool(toolName) && toolResultSucceeded(result)) next.skillUsed = true;
      if (isTool(toolName, "skill_select") && succeeded) {
        const ids = Array.isArray(args.ids) ? args.ids.filter((id): id is string => typeof id === "string" && id.trim().length > 0) : [];
        if (ids.length) {
          next.skillUsed = true;
          next.pendingReviewIds = [...new Set([...next.pendingReviewIds, ...ids])];
        }
      }
      if (isTool(toolName, "skill_create") && succeeded) {
        next.skillUsed = true;
        next.pendingReviewIds = [...new Set([...next.pendingReviewIds, skillResultId(result) || "__created__"])];
      }
      if (isTool(toolName, "skill_search") && succeeded) {
        const id = skillResultId(result);
        if (id) {
          next.skillUsed = true;
          next.pendingReviewIds = [...new Set([...next.pendingReviewIds, id])];
        }
      }
      if (isTool(toolName, "skill_load") && succeeded) {
        const id = typeof args.id === "string" ? args.id : "";
        if (id) {
          next.skillUsed = true;
          next.pendingReviewIds = [...new Set([...next.pendingReviewIds, id])];
        }
      }

      return next;
    });
    recordTelemetryTool({
      host: "copilot", sessionId, turnSeq: state.turnSeq,
      eventKey: hostEventKey || `${eventId}:${toolCallId}`, toolName, args, result,
      success: toolResultSucceeded(result), durationMs,
    });

    if (isCairnMcpTool(toolName) && !toolResultSucceeded(result)) return void emit({});
    const answer = typeof args.answer === "string" ? args.answer : "";
    const blocks = (await Promise.all(postToolFiles(toolName, answer).map(promptText))).filter((t) => t.length > 0);
    const text = internalContext(blocks.join("\n\n"));
    emit(text ? { additionalContext: text } : {});
    return;
  }

  if (mode === "agent-stop") {
    // agentStop enforces the required workflow and final completion gate.
    if (process.env.CAIRN_COPILOT_NO_STOP) return void emit({});
    if (isToolCallSession(sessionId) && !transcriptPath) {
      const stateId = turnScope(sessionId);
      updateLifecycle(stateId, (state) => ({
        ...state,
        pendingReviewIds: [],
        pendingReviews: [],
        stopBlocked: false,
      }));
      finishTelemetryRun({
        host: "copilot", sessionId, turnSeq: readLifecycle(stateId).turnSeq,
        completed: true, workflowPassed: true, skillUsed: true, brainUsed: true,
        stopNudges: 0, status: "subagent",
      });
      return void emit({});
    }
    const stateId = turnScope(sessionId);
    const st = readLifecycle(stateId);
    const enforceWorkflow = process.env.CAIRN_ENFORCE_STOP_GATES === "1" || st.cairnToolObserved;
    if (!enforceWorkflow && !st.cairnToolAttempted && !st.cairnVisibilityNudged) {
      updateLifecycle(stateId, () => ({
        ...st,
        cairnVisibilityNudged: true,
        stopBlocked: true,
      }));
      recordTelemetryState({
        host: "copilot", sessionId, turnSeq: st.turnSeq,
        eventKey: hostEventKey || `${sessionId}:${st.turnSeq}:visibility`,
        kind: "visibility_failure",
      });
      emit({ decision: "block", reason: internalContext(CAIRN_VISIBILITY_REMINDER) });
      return;
    }
    const file = enforceWorkflow ? stopDecision({
      brainUsed: st.brainUsed,
      skillUsed: st.skillUsed,
      stopNudges: st.stopNudges,
    }).file : "";
    const text = file ? internalContext(await promptText(file)) : "";
    if (text) {
      updateLifecycle(stateId, () => ({ ...st, stopNudges: st.stopNudges + 1, stopBlocked: true }));
      recordTelemetryState({
        host: "copilot", sessionId, turnSeq: st.turnSeq,
        eventKey: hostEventKey || `${sessionId}:${st.turnSeq}:workflow`,
        kind: "stop_blocked",
      });
      emit({ decision: "block", reason: text });
      return;
    }
    if (process.env.AGENT_HARNESS === "1" && harnessTurnDeferred()) {
      // A waiting task will resume in a new turn after its dependency completes.
      updateLifecycle(stateId, () => ({
        ...st,
        pendingReviewIds: [],
        pendingReviews: [],
        stopBlocked: false,
      }));
      finishTelemetryRun({
        host: "copilot", sessionId, turnSeq: st.turnSeq, completed: false,
        workflowPassed: st.brainUsed && st.skillUsed, skillUsed: st.skillUsed,
        brainUsed: st.brainUsed, stopNudges: st.stopNudges, status: "deferred",
      });
      emit({});
      return;
    }
    if (!st.completionNudged) {
      updateLifecycle(stateId, () => ({ ...st, completionNudged: true, stopBlocked: true }));
      recordTelemetryState({
        host: "copilot", sessionId, turnSeq: st.turnSeq,
        eventKey: hostEventKey || `${sessionId}:${st.turnSeq}:completion`,
        kind: "stop_blocked",
      });
      emit({ decision: "block", reason: internalContext(COMPLETION_REMINDER) });
      return;
    }
    updateLifecycle(stateId, () => ({ ...st, pendingReviewIds: [], pendingReviews: [], stopBlocked: false }));
    finishTelemetryRun({
      host: "copilot", sessionId, turnSeq: st.turnSeq, completed: true,
      workflowPassed: st.brainUsed && st.skillUsed, skillUsed: st.skillUsed,
      brainUsed: st.brainUsed, stopNudges: st.stopNudges,
    });
    releaseDelegation(sessionId);
    emit({});
    return;
  }

  emit({});
}

if (import.meta.main) {
  await main();
  // A timed-out stdin read leaves Bun.stdin.text()'s read handle open, which keeps this process (and any
  // host that waits for the hook to EXIT, not just for its stdout) alive until the host finally closes
  // stdin — the freeze we are guarding against. Flush our emitted JSON, then exit explicitly so the
  // dangling handle can never hold the host. The detached skill-learner is child.unref()'d, so it survives.
  await new Promise<void>((resolve) => process.stdout.write("", () => resolve()));
  process.exit(0);
}
