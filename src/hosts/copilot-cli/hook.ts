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
//   post-tool      (postToolUse)         : after a brain_* or Task tool, inject the matching reminder, record
//                                          brain/skill usage, and persist successful skill_review declarations.
//   agent-stop     (agentStop)           : the Stop equivalent — decision:"block" forces another turn. Used
//                                          for turn-reminder.md (brain unused) and skill-review.md (a skill
//                                          was used but not submitted via skill_review). Once all gates pass,
//                                          enqueue declared reviews over the complete turn transcript.
//   subagent-start (subagentStart)       : additionalContext is PREPENDED to the subagent's own prompt —
//                                          the one channel that reaches a subagent's window (subagent-protocol.md).
//
// Per-event context on PreToolUse remains unreachable; the brain_create gate enforces the format intent instead.
import { readFile } from "node:fs/promises";
import {
  appendFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { isSystemEnvelope } from "../../skill/noise";
import { recordHostEvent } from "../../core/host-events";
import { formatSkillCatalog, selectedSkillBlock, skillIdsFromTask } from "../../skill/catalog";
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
import { recordMissedReviews } from "../../skill/missed-review";

const PROMPTS = new URL("../../../prompts/", import.meta.url);
const emit = (obj: object) => process.stdout.write(JSON.stringify(obj));
export const internalContext = (text: string): string => text ? `<cairn-internal>\n${text}\n</cairn-internal>` : "";

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
const workflowPrompt = (): Promise<string> =>
  promptWithCatalog(process.env.AGENT_HARNESS === "1" ? "harness-agent.md" : "user-message.md");

// MCP tools arrive server-prefixed ("cairn-brain_search") or bare/namespaced ("brain_search" /
// "mcp__cairn__brain_search"); accept any of those forms.
export const isTool = (name: string, want: string): boolean =>
  name === want || name.endsWith(want) || name.includes(want);
const isTask = (name: string): boolean => /^(task|agent)$/i.test(name) || name === "Task" || name === "Agent";

// ── Pure decision helpers (exported for unit tests) ────────────────────────────────────────────

// Which prompt files a COMPLETED tool earns, in delivery order. Mirrors Claude EXACTLY: Claude hooks
// entry-format on PreToolUse (before a brain write) and orchestrate on PreToolUse (before a Task spawn),
// but Claude delivers that PreToolUse additionalContext to the model AFTER the tool returns — the same
// moment as its PostToolUse reminder. Copilot's preToolUse has no additionalContext channel, so we
// deliver BOTH files here at postToolUse to land the identical text at the identical point. The empty
// node-modified.md is dropped by the caller (it injects nothing on Claude either).
export function postToolFiles(toolName: string, answer: string): string[] {
  if (isTool(toolName, "brain_search")) return ["search-results.md"];
  if (isTool(toolName, "brain_create")) return ["entry-format.md", "node-created.md"];
  if (isTool(toolName, "brain_mutate")) return ["entry-format.md", answer.trim() ? "answer-check.md" : "node-modified.md"];
  if (isTask(toolName)) return ["orchestrate.md", "subtask-spawned.md"];
  return [];
}

// Whether agentStop should force another turn, and with which prompt. Bounded to STOP_CAP nudges per
// turn so a stubborn agent can never be looped forever (Copilot sends no stop_hook_active flag).
// If the agent used a skill this turn but is ending WITHOUT submitting the result via skill_review, block
// and inject the skill-review reminder so the finished work is actually graded.
export const STOP_CAP = 2;
export function stopDecision(s: { brainUsed: boolean; skillUsed: boolean; pendingReviewCount: number; stopNudges: number }): {
  file: string;
} {
  if (s.stopNudges >= STOP_CAP) return { file: "" };
  if (!s.skillUsed) return { file: "skill-search-reminder.md" };
  if (!s.brainUsed) return { file: "turn-reminder.md" };
  if (s.pendingReviewCount > 0) return { file: "skill-review.md" };
  return { file: "" };
}

export function harnessStopDecision(s: { skillUsed: boolean; pendingReviewCount: number; stopNudges: number }): {
  file: string;
} {
  if (s.stopNudges >= STOP_CAP) return { file: "" };
  if (!s.skillUsed) return { file: "skill-search-reminder.md" };
  if (s.pendingReviewCount > 0) return { file: "skill-review.md" };
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
    };
  } catch {
    return { sessionId: "", agentId: "", agentName: "", toolName: "", args: {}, result: undefined, transcriptPath: "", prompt: "", eventId: "", toolCallId: "" };
  }
}

export const shouldStartUserTurn = (prompt: string): boolean =>
  !isSystemEnvelope(prompt);

// Durably enqueue the latest matching skill_review event. Capacity only delays the queued job; acceptance
// marks the turn reviewed immediately so agentStop never asks the agent to resubmit work it already submitted.
async function queueLatestReview(
  transcriptPath: string,
  sessionId: string,
  options: {
    skillId?: string;
    agentId?: string;
    agentName?: string;
    subagentOnly?: boolean;
    eventId?: string;
    backend?: string;
  } = {}
): Promise<boolean> {
  if (!transcriptPath || !sessionId) return false;
  try {
    const { skillsEnabled } = await import("../../core/config");
    if (!skillsEnabled()) return false;
    const { learnCopilotReviews, learnFromTranscript } = await import("../../skill/learn");
    if (options.skillId && !options.subagentOnly) {
      const { transcriptReviewKey } = await import("../../skill/review-queue");
      return learnFromTranscript(transcriptPath, options.skillId, {
        id: options.eventId
          ? `${sessionId}:${options.agentId || "main"}:${options.eventId}:${options.skillId}`
          : transcriptReviewKey(transcriptPath, options.skillId, sessionId),
        sessionId,
        backend: options.backend ?? "copilot",
      });
    }
    return learnCopilotReviews(transcriptPath, sessionId, options);
  } catch {
    return false; // skills are best-effort
  }
}

// Copilot writes each session's turn log to ~/.copilot/session-state/<sessionId>/events.jsonl. postToolUse
// (where skill_review is detected) carries only the sessionId, not a transcript path, so we reconstruct the
// events-log path from it to review the whole turn — including any subagent output already written there.
export function eventsPathForSession(sessionId: string): string {
  const home = process.env.COPILOT_HOME || join(homedir(), ".copilot");
  return join(home, "session-state", sessionId, "events.jsonl");
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
  // let the learner's own agentStop kick off another learner (infinite recursion). The learner sets
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
  try { recordHostEvent("copilot", mode ?? "", raw, rawPayload); } catch { /* event indexing never blocks the host */ }

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

  const { sessionId, agentId, agentName, toolName, args, result, transcriptPath, prompt, eventId, toolCallId } = parsePayload(raw);

  if (mode === "subagent-stop") {
    const path = transcriptPath || eventsPathForSession(sessionId);
    const { latestCopilotAgentId } = await import("../../skill/review-queue");
    const stoppingAgentId = agentId || latestCopilotAgentId(path, agentName);
    const stateId = turnScope(sessionId, stoppingAgentId);
    const state = readLifecycle(stateId);
    await queueLatestReview(path, sessionId, {
      agentId: stoppingAgentId || undefined,
      agentName: stoppingAgentId ? undefined : agentName || undefined,
      subagentOnly: true,
    });
    updateLifecycle(stateId, () => ({ ...state, stopBlocked: false }));
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
    // Copilot can re-fire this hook for a blocked continuation. Preserve the cap only for that continuation,
    // then let the next genuine user turn start with a fresh budget.
    const stateId = turnScope(sessionId);
    const delegatedIds = claimDelegation(sessionId, stateId);
    if (delegatedIds.length) {
      resetLifecycle(stateId, { brainUsed: true, skillUsed: true });
      return void emit({});
    }
    if (!shouldStartUserTurn(prompt)) return void emit({});
    resetLifecycle(stateId, {}, true);
    const wf = await workflowPrompt();
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
    updateLifecycle(stateId, (current) => {
      const next = { ...current };
      if (isTool(toolName, "brain_search") || isTool(toolName, "brain_mutate")) next.brainUsed = true;
      if (isTool(toolName, "skill_select")) {
        const ids = Array.isArray(args.ids) ? args.ids.filter((id): id is string => typeof id === "string" && id.trim().length > 0) : [];
        if (ids.length) {
          next.skillUsed = true;
          next.pendingReviewIds = [...new Set([...next.pendingReviewIds, ...ids])];
        }
      }
      if (isTool(toolName, "skill_create")) {
        next.skillUsed = true;
        next.pendingReviewIds = [...new Set([...next.pendingReviewIds, skillResultId(result) || "__created__"])];
      }
      if (isTool(toolName, "skill_search")) {
        next.skillUsed = true;
        next.pendingReviewIds = [...new Set([...next.pendingReviewIds, "__legacy__"])];
      }
      if (isTool(toolName, "skill_load")) {
        const id = typeof args.id === "string" ? args.id : "";
        if (id) {
          next.skillUsed = true;
          next.pendingReviewIds = [...new Set([...next.pendingReviewIds, id])];
        }
      }

      if (isTool(toolName, "skill_review") && toolResultSucceeded(result)) {
        const id = typeof args.id === "string" ? args.id : "";
        next.skillUsed = true;
        if (id) {
          next.pendingReviewIds = next.pendingReviewIds.filter((pendingId) =>
            pendingId !== id && pendingId !== "__created__" && pendingId !== "__legacy__"
          );
          const declaration = { skillId: id, eventId };
          if (!next.pendingReviews.some((review) =>
            review.skillId === declaration.skillId && review.eventId === declaration.eventId
          )) next.pendingReviews.push(declaration);
        }
      }
      return next;
    });

    const answer = typeof args.answer === "string" ? args.answer : "";
    const blocks = (await Promise.all(postToolFiles(toolName, answer).map(promptText))).filter((t) => t.length > 0);
    const text = internalContext(blocks.join("\n\n"));
    emit(text ? { additionalContext: text } : {});
    return;
  }

  if (mode === "agent-stop") {
    // skill_review declares which skill owns the deliverable. agentStop enforces the required workflow first,
    // then queues each declaration over the complete transcript, including the final visible answer.
    if (process.env.CAIRN_COPILOT_NO_STOP) return void emit({});
    const path = transcriptPath || eventsPathForSession(sessionId);
    const stateId = turnScope(sessionId);
    const st = readLifecycle(stateId);
    const file = process.env.AGENT_HARNESS === "1"
      ? harnessStopDecision({ skillUsed: st.skillUsed, pendingReviewCount: st.pendingReviewIds.length, stopNudges: st.stopNudges }).file
      : stopDecision({ brainUsed: st.brainUsed, skillUsed: st.skillUsed, pendingReviewCount: st.pendingReviewIds.length, stopNudges: st.stopNudges }).file;
    const text = file ? internalContext(await promptText(file)) : "";
    if (text) {
      updateLifecycle(stateId, () => ({ ...st, stopNudges: st.stopNudges + 1, stopBlocked: true }));
      emit({ decision: "block", reason: text }); // nudge the agent to review before ending
      return;
    }
    for (const review of st.pendingReviews) {
      const accepted = await queueLatestReview(path, sessionId, {
        skillId: review.skillId,
        eventId: review.eventId,
      });
      if (!accepted) {
        if (st.reviewNudges >= STOP_CAP) {
          updateLifecycle(stateId, () => ({ ...st, stopBlocked: false }));
          emit({});
          return;
        }
        updateLifecycle(stateId, () => ({ ...st, reviewNudges: st.reviewNudges + 1, stopBlocked: true }));
        emit({
          decision: "block",
          reason: internalContext("Cairn could not durably queue the declared skill review. Keep the turn open and retry ending it; do not dismiss this continuation."),
        });
        return;
      }
    }
    if (st.pendingReviewIds.length) {
      recordMissedReviews(stateId, st.turnSeq, st.pendingReviewIds, path);
      updateLifecycle(stateId, () => ({ ...st, stopBlocked: false }));
      emit({});
      return;
    }
    updateLifecycle(stateId, () => ({ ...st, pendingReviewIds: [], pendingReviews: [], stopBlocked: false }));
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
