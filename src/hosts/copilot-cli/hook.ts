#!/usr/bin/env bun
// GitHub Copilot CLI hooks for Cairn. argv[2] selects the mode, one per hook event registered by
// setup.ts. As of Copilot CLI v1.0.66 the hook surface is much wider than the original two events,
// so Cairn now reaches near-parity with Claude Code (see docs.github.com/.../hooks-reference):
//
//   user-prompt    (userPromptSubmitted) : inject the workflow and reset the per-turn latch.
//   session-start  (sessionStart)        : legacy fallback used only when the installer detects a Copilot
//                                          version that cannot deliver userPromptSubmitted context.
//   pre-tool       (preToolUse)          : gate premature Harness side effects and invalid brain_create
//                                          structure. preToolUse can only allow, deny, or modify arguments.
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
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { isSystemEnvelope } from "../../skill/noise";
import { recordHostEvent } from "../../core/host-events";
import {
  beginTelemetryRun,
  finishTelemetryRun,
  recordTelemetry,
  recordTelemetryState,
  recordTelemetryTool,
} from "../../core/telemetry-record";
import { promptFingerprint } from "../../core/release";
import { formatSkillCatalog, selectedSkillBlock, skillCatalogSnapshot, skillIdsFromTask } from "../../skill/catalog";
import {
  lifecycleScope,
  readLifecycle,
  registerDelegation,
  releaseDelegation,
  resetLifecycle,
  updateLifecycle,
} from "../../skill/lifecycle";
import { skillResultId, skillResultIds, selectedSkillIds } from "../../skill/tool-result";
import { postToolPromptFiles } from "../../inject/post-tool";
import { completionContinuationEnabled } from "./completion-gate";
import {
  CONTRACT_DECLARE_REASON,
  CONTRACT_UNAVAILABLE_REASON,
  clearInstrumentDoubt,
  contractInstrumentMissing,
  contractInstrumentReported,
  markContractInstrumentReported,
  noteUndeclaredNudge,
  sessionStatePath,
  contractDeclared,
  contractExhausted,
  clearContract,
  contractStopReason,
  noteContractNudge,
  readContract,
  recordObservedRun,
} from "./contract";

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
const complianceReceiptPath = (sessionId: string): string =>
  sessionStatePath(sessionId, "cairn-compliance.json");
const COMPLETION_REMINDER = "Ensure you completed every requested task.";
const SKILL_APPLICATION_REMINDER =
  "End with one compact **Cairn** receipt: `Root — synthesis (URL)`; `Coverage — validation and why nothing remains`; `Recall — improvement`; `Skill application — step N: action/result` for every selected or invoked skill; `Skill update — exact skill_edit change and why`, or `none — steps remained accurate and complete`. Report observable evidence, not hidden reasoning.";
const CAIRN_VISIBILITY_REMINDER =
  "Cairn's required brain and skill tools failed in this session. The CLI may have cached an earlier MCP startup failure. Final submission remains blocked: tell the user to run `/restart` once, then complete the required Cairn skill and Brain workflow.";

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
// Harness agents already carry a task-specific role prompt from the project config, so they get the
// leaner harness-workflow.md instead of the full user-message.md aimed at an unscoped interactive user —
// avoids stacking redundant generic explanation on top of an already-scoped role prompt.
const workflowPrompt = (): Promise<string> =>
  promptWithCatalog(process.env.AGENT_HARNESS === "1" ? "harness-workflow.md" : "user-message.md");
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
  "skill_select", "skill_create", "skill_edit",
].some((tool) => isTool(name, tool));
const isTask = (name: string): boolean => /^(task|agent)$/i.test(name) || name === "Task" || name === "Agent";

// ── Pure decision helpers (exported for unit tests) ────────────────────────────────────────────

// Which state-specific prompt files a completed tool earns, in delivery order. The per-turn workflow and
// tool schemas already carry invariant write rules, so search/create receive only their new next-step delta.
export function postToolFiles(toolName: string, answer: string): string[] {
  return postToolPromptFiles(toolName, answer);
}

// Whether agentStop should force another turn, and with which prompt. Final submission stays blocked
// until the mandatory Cairn workflow succeeds; ordinary tools remain available for recovery.
export const STOP_CAP = 2;
// A dependency that is DOWN cannot be satisfied by trying harder. If the Cairn MCP transport is
// unreachable, skill_select and brain_search can never succeed, so every fail-closed branch below nudges
// forever — observed live: five identical continuations demanding a skill call against a dead server.
// Past a cap deliberately set above STOP_CAP the gate releases, so an impossible precondition leaves as a
// reported outage instead of an infinite loop. A turn that merely skipped Cairn still pays every nudge.
export const OUTAGE_CAP = STOP_CAP * 2;
interface WorkflowEvidence {
  brainUsed: boolean;
  brainSearched?: boolean;
  brainCreatedCount?: number;
  brainAnsweredCount?: number;
  brainReusedCount?: number;
  /** Nodes the turn CREATED and never answered. Optional so existing callers keep the count fallback. */
  openCreatedCount?: number;
  rootSynthesized?: boolean;
  skillUsed: boolean;
  pendingReviewCount?: number;
  stopNudges: number;
  strict?: boolean;
  minimumBrainNodes?: number;
  pendingSkillCorrections?: number;
  skillCorrectionNudges?: number;
}
export function stopDecision(s: WorkflowEvidence): {
  file: string;
} {
  if (s.stopNudges >= OUTAGE_CAP) return { file: "" };
  if ((s.pendingSkillCorrections ?? 0) > 0) {
    return { file: "skill-correction-reminder.md" };
  }
  if (!s.skillUsed) return { file: "skill-search-reminder.md" };
  if (s.strict && !brainWorkComplete(s)) {
    // Searching and finding nothing to reuse is a different failure from never searching, and from
    // finding prior work. Naming the actual state is what stops the agent from "fixing" a reuse turn
    // by inventing duplicate nodes.
    return { file: (s.brainSearched && (s.brainCreatedCount ?? 0) === 0)
      ? "brain-reuse-reminder.md"
      : "turn-reminder.md" };
  }
  if (!s.brainUsed) return { file: "turn-reminder.md" };
  return { file: "" };
}

// A turn discharges its Brain obligation one of two ways, and BOTH are complete work:
//   • It researched something new: it created the decomposition, answered every node it created, and
//     synthesized the root last.
//   • Prior work already answered the task: it adopted those existing nodes instead of duplicating
//     them. Requiring fresh nodes here is what forced agents to re-create work the graph already held,
//     which corrupts recall with duplicates and is the exact opposite of the instruction to reuse.
// Reuse must still be recorded, not merely claimed: a bare search proves nothing, so the turn has to
// mutate a node that its own search actually returned.
function brainWorkComplete(s: WorkflowEvidence): boolean {
  if (!s.brainSearched) return false;
  const created = s.brainCreatedCount ?? 0;
  const reused = s.brainReusedCount ?? 0;
  if (created === 0) return reused > 0;
  // The COUNT floor is a depth heuristic, not an invariant, and it is the only part of this predicate a
  // turn can fail while having genuinely done the work. Left unbounded it re-blocks forever (observed:
  // stop_nudges=3 against a nominal STOP_CAP of 2), so past the cap the floor relaxes to one node. Every
  // real invariant — searched, a node created, all created nodes answered, root synthesized last — still
  // holds after the cap, so a turn that skipped Cairn is still blocked indefinitely.
  const floor = s.stopNudges >= STOP_CAP ? 1 : (s.minimumBrainNodes ?? 1);
  // OWNERSHIP, not arithmetic. Comparing COUNTS let a turn discharge its obligation with answers to
  // nodes it did not create: created 3 / answered 3 released while two created nodes were still open,
  // because two of those answers were mutations of pre-existing nodes. Every question the turn OPENED
  // must be the question it closed, which is what makes decomposition go deeper instead of sideways.
  const owed = (s.openCreatedCount ?? Math.max(0, created - (s.brainAnsweredCount ?? 0))) > 0;
  return created + reused >= floor
    && !owed
    && Boolean(s.rootSynthesized);
}

const NON_EXECUTION_TOOLS =
  /^(read|view|glob|grep|rg|search|web_fetch|web_search|ask_user|sql|list_|get_|fetch_|manage_schedule)/i;
export function failedExecutionDisprovesSkill(toolName: string, succeeded: boolean): boolean {
  return !succeeded
    && !isCairnMcpTool(toolName)
    && !isNativeSkillTool(toolName)
    && !NON_EXECUTION_TOOLS.test(toolName);
}

const READ_ONLY_TOOLS = /^(read|view|glob|grep|rg|search|web_fetch|web_search|fetch_copilot_cli_documentation|list_|get_)/i;
const SHELL_MUTATION = /(?:^|[;&|]\s*)(?:set-content|add-content|out-file|remove-item|move-item|copy-item|rename-item|new-item|stop-process|start-process)\b|\bgit\s+(?:add|commit|push|checkout|switch|reset|clean|merge|rebase|tag)\b|\baz\s+repos\s+pr\s+(?:create|update)\b|\baz\s+devops\s+invoke\b[\s\S]*?--http-method\s+(?:post|put|patch|delete)\b|(?:^|[^<])>{1,2}(?![>&])/i;
const workflowReady = (s: WorkflowEvidence): boolean => s.skillUsed && brainWorkComplete(s);

// A turn that only read the repository to answer a question is genuinely resolved by a root plus the
// children its evidence needs, so a flat floor only buys padding nodes and extra stop continuations.
// Turns that actually changed something keep the full decomposition floor. Every fail-closed invariant
// (skill selected, brain searched, a root created, all nodes answered, root synthesized last) is
// unchanged, so a turn that skips Cairn is still blocked.
export function requiredBrainNodes(executionToolCalls: number): number {
  const full = Math.max(1, Number(process.env.CAIRN_MIN_BRAIN_NODES || "3"));
  const readOnly = Math.max(1, Number(process.env.CAIRN_MIN_BRAIN_NODES_READONLY || "1"));
  return executionToolCalls > 0 ? full : Math.min(readOnly, full);
}

export function countsAsExecution(toolName: string, args: Record<string, unknown> = {}): boolean {
  const command = typeof args.command === "string" ? args.command : "";
  const readOnlyShell = /powershell|bash|shell/i.test(toolName) && !SHELL_MUTATION.test(command);
  return !isCairnMcpTool(toolName)
    && !isNativeSkillTool(toolName)
    && !READ_ONLY_TOOLS.test(toolName)
    && !readOnlyShell;
}

// Writing a script, running it, and deleting it leaves nothing behind: that is how a shell READS what no
// native tool can reach — querying SQLite, for instance — not something the turn changed. Such a command
// must still satisfy countsAsExecution, because the fail-closed action gate has to hold any write until
// the workflow completes. The decomposition floor asks a different question, "did this turn do work deep
// enough to need more nodes?", and answering it with a temp file inflates a floor whose only remedy is
// creating nodes the graph does not need — the same padding pressure 5d5e439 removed for reuse.
const DURABLE_SHELL_VERB =
  /\bgit\s+(?:add|commit|push|checkout|switch|reset|clean|merge|rebase|tag)\b|(?:^|[;&|]\s*)(?:move-item|copy-item|rename-item|stop-process|start-process)\b|\baz\s+/i;
const WRITE_VERB = /(?:^|[;&|]\s*)(?:set-content|add-content|out-file|new-item)\b|(?:^|[^<])>{1,2}(?![>&])/i;
const REMOVE_VERB = /(?:^|[;&|]\s*)remove-item\b/i;
const SCRATCH_LOCATION = /\$env:TEMP|%TEMP%|[\\/]tmp[\\/]|[\\/]temp[\\/]|session-state/i;

const fileNames = (text: string): string[] =>
  [...text.matchAll(/[\w$.:\\/-]*[\w-]+\.[a-z0-9]{1,6}\b/gi)]
    .map((match) => match[0].toLowerCase().replace(/^.*[\\/]/, ""));

// True when every file the command creates is also deleted by it, or lives in a scratch location.
export function scratchOnlyShellCommand(command: string): boolean {
  if (!command || DURABLE_SHELL_VERB.test(command)) return false;
  const written = new Set<string>();
  const removed = new Set<string>();
  for (const statement of command.split(/[;|]|&&/).map((part) => part.trim())) {
    const target = WRITE_VERB.test(statement) ? written : REMOVE_VERB.test(statement) ? removed : null;
    if (target) for (const name of fileNames(statement)) target.add(name);
  }
  if (!written.size) return false;
  return [...written].every((name) => removed.has(name) || SCRATCH_LOCATION.test(name));
}

// Whether a completed tool call did work durable enough to warrant the full decomposition floor.
export function changesDurableState(toolName: string, args: Record<string, unknown> = {}): boolean {
  if (!countsAsExecution(toolName, args)) return false;
  const command = typeof args.command === "string" ? args.command : "";
  return !scratchOnlyShellCommand(command);
}

export function workflowActionDecision(
  toolName: string,
  state: WorkflowEvidence,
  args: Record<string, unknown> = {},
): { deny: boolean; reason?: string } {
  if (!state.strict || !countsAsExecution(toolName, args)) {
    return { deny: false };
  }
  if (workflowReady(state)) return { deny: false };
  return {
    deny: true,
    reason:
      "Finish the injected Cairn workflow before acting: select a skill, search the brain, create and answer the required decomposition nodes, then synthesize the root. The requested side effect was not executed.",
  };
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
// A shell tool reports resultType "success" for a command that exited NON-ZERO: the host puts the status
// in the result text, verified in a live transcript ("completed with exit code 1" under resultType
// "success"). Without this, a failing check would close the criterion it was meant to disprove. This
// parses the HOST's own result format, which is fixed, not anything about the task being performed.
export const reportedNonZeroExit = (result: unknown): boolean => {
  const text = typeof result === "object" && result
    ? String((result as { textResultForLlm?: unknown }).textResultForLlm ?? "")
    : "";
  const match = text.match(/exit code (\d+)/i);
  return match ? match[1] !== "0" : false;
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
  model: string;
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
      model: String(j.model ?? ""),
    };
  } catch {
    return { sessionId: "", agentId: "", agentName: "", toolName: "", args: {}, result: undefined, transcriptPath: "", prompt: "", eventId: "", toolCallId: "", durationMs: 0, model: "" };
  }
}

export function resolveCopilotModel(
  payloadModel: string,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const explicit = payloadModel.trim();
  if (explicit) return explicit;
  const harnessModel = environment.CAIRN_MODEL?.trim();
  if (harnessModel) return harnessModel;
  const copilotHome = environment.COPILOT_HOME || join(homedir(), ".copilot");
  try {
    const settings = JSON.parse(readFileSync(join(copilotHome, "settings.json"), "utf8")) as {
      model?: unknown;
    };
    return typeof settings.model === "string" ? settings.model.trim() : "";
  } catch {
    return "";
  }
}

export const shouldStartUserTurn = (prompt: string): boolean =>
  !isSystemEnvelope(prompt);

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
export async function runCopilotHook(): Promise<void> {
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
  const {
    sessionId, agentId, agentName, toolName, args, result, transcriptPath, prompt,
    eventId, toolCallId, durationMs, model: payloadModel,
  } = parsePayload(raw);
  const model = resolveCopilotModel(payloadModel);
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
    const { latestCopilotAgentId } = await import("../../skill/transcript-copilot");
    const stoppingAgentId = agentId || latestCopilotAgentId(transcriptPath, agentName);
    const stateId = turnScope(sessionId, stoppingAgentId);
    resetLifecycle(stateId, { brainUsed: true, skillUsed: true });
    emit({});
    return;
  }

  if (mode === "user-prompt") {
    // A source checkout drifts past the install-time hook label on every commit, so telemetry stamps
    // stale releases and hook/runtime attribution diverges mid-session. Heal it once per turn.
    try {
      const { healReleaseLabel } = await import("../../core/runtime-identity");
      const { releaseVersion } = await import("../../core/release");
      healReleaseLabel(releaseVersion);
    } catch { /* a stale release label must never block a turn */ }
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
    if (!shouldStartUserTurn(prompt)) return void emit({});
    rmSync(complianceReceiptPath(sessionId), { force: true });
    clearContract();
    try { (await import("../../core/auto-update")).maybeAutoUpdate(); }
    catch { /* self-update is background work and never blocks a turn */ }
    const state = resetLifecycle(stateId);
    if (emittedUsage) emittedUsage.turnSeq = state.turnSeq;
    const wf = await workflowPrompt();
    // A host reads its hook configuration once, when the session starts, so a session that began before
    // a config change runs the OLD hooks for its entire life and cannot reload them. When that change
    // added the pre-tool gate, the gate silently never fires for that session and nothing inside it can
    // tell. Surface it instead, once per turn, so a stale session is visible rather than quietly ungated.
    // Requiring several distinct tools rules out a lone pre/post race between two hook processes.
    let staleHooks = "";
    try {
      const { unannouncedTools } = await import("../../core/host-events");
      const missed = unannouncedTools("copilot", sessionId);
      if (missed.length >= 3) {
        staleHooks = `This session started before the currently installed Cairn hook configuration, so its `
          + `pre-tool gate is NOT running: ${missed.length} tools have run unannounced (${missed.slice(0, 3).join(", ")}). `
          + `A host loads hook config only at session start, so this session cannot restore the gate itself. `
          + `Tell the user, in your reply, that this session predates the current Cairn install and that a new `
          + `session is required for the gate to apply.`;
      }
    } catch { /* a stale-config notice must never block a turn */ }
    const injected = [wf, staleHooks].filter((part) => part.length > 0).join("\n\n");
    beginTelemetryRun({
      host: "copilot", sessionId, turnSeq: state.turnSeq,
      promptHash: promptFingerprint(wf), catalogVersion: catalogVersion(),
      injectedChars: internalContext(injected).length, model,
    });
    emit(injected ? { additionalContext: internalContext(injected) } : {});
    return;
  }

  if (mode === "pre-tool") {
    // preToolUse command hooks are FAIL-CLOSED (a crash denies the tool), so default to allow and only
    // ever deny on an explicit gate match.
    // The ONLY signal that separates "Cairn is unreachable" from "the agent ignored Cairn" was recorded
    // in post-tool, which never runs when the call dies at the transport — so an outage was indexed as
    // defiance and nudged forever (observed: ten identical skill_select demands against a dead server).
    // The attempt is therefore recorded here, before execution, where a failing transport cannot erase it.
    if (isCairnMcpTool(toolName)) {
      updateLifecycle(turnScope(sessionId, agentId), (current) => ({ ...current, cairnToolAttempted: true }));
    }
    let decision: { deny: boolean; reason?: string } = { deny: false };
    try {
      if (process.env.AGENT_HARNESS === "1" && !agentId) {
        const state = readLifecycle(turnScope(sessionId));
        decision = workflowActionDecision(toolName, {
          ...state,
          brainCreatedCount: state.brainCreatedIds.length,
          brainAnsweredCount: state.brainAnsweredIds.length,
          brainReusedCount: state.brainReusedIds.length,
          strict: true,
          minimumBrainNodes: requiredBrainNodes(1),
        }, args);
        if (decision.deny) {
          emit({ permissionDecision: "deny", permissionDecisionReason: decision.reason });
          return;
        }
      }
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
    // Conditional by construction: only a tool that would CHANGE something needs a declared contract, so
    // a conversational turn never sees this gate. Delegation is excluded for the same reason a read-only
    // shell is: spawning a subagent alters nothing durable by itself, and it is the channel Cairn uses to
    // reach that subagent, so denying it here severs delegation and protocol injection. This is not a
    // loophole now that the subagent exemptions are gone — the child runs Cairn and pays the gate for its
    // own execution tools. Checked AFTER the delegation branches, which only return early when they
    // actually inject a protocol.
    // `contractInstrumentMissing` releases this deny for a session that provably cannot call the tool.
    // Without it the brick is total rather than annoying: `nudges` only rises when a turn STOPS, so at
    // the start of every turn an instrument-less session has a fresh zero count and every execution tool
    // it needs is denied until it has stopped past the cap.
    if (!decision.deny && !isTask(toolName) && countsAsExecution(toolName, args)
      && !contractDeclared() && !contractExhausted() && !contractInstrumentMissing(sessionId)) {
      emit({ permissionDecision: "deny", permissionDecisionReason: CONTRACT_DECLARE_REASON });
      return;
    }
    emit(decision.deny ? { permissionDecision: "deny", permissionDecisionReason: decision.reason } : {});
    return;
  }

  if (mode === "post-tool") {
    // Record brain usage for the turn-end gate: brain_search/brain_mutate mark the turn as "used the brain".
    const stateId = turnScope(sessionId, agentId);
    if (typeof args.command === "string") {
      recordObservedRun(args.command, toolResultSucceeded(result) && !reportedNonZeroExit(result));
    }
    let correctionRequired = false;
    let correctionResolved = false;
    const state = updateLifecycle(stateId, (current) => {
      const next = { ...current };
      const succeeded = toolResultSucceeded(result);
      const resultId = skillResultId(result);
      if (isCairnMcpTool(toolName)) next.cairnToolAttempted = true;
      if (isCairnMcpTool(toolName) && succeeded) next.cairnToolObserved = true;
      if (changesDurableState(toolName, args)) next.executionToolCalls += 1;
      if ((isTool(toolName, "brain_search") || isTool(toolName, "brain_mutate")) && succeeded) next.brainUsed = true;
      if (isTool(toolName, "brain_search") && succeeded) {
        next.brainSearched = true;
        next.brainSearchIds = [...new Set([...next.brainSearchIds, ...skillResultIds(result)])];
      }
      if (isTool(toolName, "brain_create") && succeeded && resultId) {
        next.brainCreatedIds = [...new Set([...next.brainCreatedIds, resultId])];
        if (!next.rootNodeId) next.rootNodeId = resultId;
      }
      if (isTool(toolName, "brain_mutate") && succeeded) {
        const id = typeof args.id === "string" ? args.id : "";
        // Mutating a node this turn found but did not create is the recorded proof of reuse: the turn
        // extended prior work instead of duplicating it.
        if (id && !next.brainCreatedIds.includes(id) && next.brainSearchIds.includes(id)) {
          next.brainReusedIds = [...new Set([...next.brainReusedIds, id])];
        }
        if (typeof args.answer === "string" && args.answer.trim()) {
          if (id) next.brainAnsweredIds = [...new Set([...next.brainAnsweredIds, id])];
          // A turn that reuses an existing node instead of creating a new one (the encouraged
          // "search, then mutate rather than duplicate" path) never calls brain_create, so it would
          // otherwise finish with an empty rootNodeId and fail the terminal-session compliance check.
          // The first node this turn actually answers anchors the turn's work, same as a fresh create.
          if (id && !next.rootNodeId) next.rootNodeId = id;
          if (id && id === next.rootNodeId) next.rootSynthesized = true;
        }
      }
      if (isNativeSkillTool(toolName) && toolResultSucceeded(result)) next.skillUsed = true;
      if (isTool(toolName, "skill_select") && succeeded) {
        const { ids, noMatch } = selectedSkillIds(args.ids, result);
        if (ids.length || noMatch) {
          next.skillUsed = true;
          next.selectedSkillIds = [...new Set([...next.selectedSkillIds, ...ids])];
          next.pendingReviewIds = [...new Set([...next.pendingReviewIds, ...ids])];
        }
      }
      if (isTool(toolName, "skill_create") && succeeded) {
        const id = skillResultId(result);
        next.skillUsed = true;
        if (id) next.selectedSkillIds = [...new Set([...next.selectedSkillIds, id])];
        next.pendingReviewIds = [...new Set([...next.pendingReviewIds, id || "__created__"])];
      }
      if (failedExecutionDisprovesSkill(toolName, succeeded) && next.selectedSkillIds.length) {
        const invalidated = [...new Set([...next.invalidatedSkillIds, ...next.selectedSkillIds])];
        correctionRequired = invalidated.length > next.invalidatedSkillIds.length;
        next.invalidatedSkillIds = invalidated;
      }
      if (isTool(toolName, "skill_edit") && succeeded) {
        const id = typeof args.id === "string" ? args.id.trim() : "";
        if (id && next.invalidatedSkillIds.includes(id)) {
          next.invalidatedSkillIds = next.invalidatedSkillIds.filter((skillId) => skillId !== id);
          correctionResolved = next.invalidatedSkillIds.length === 0;
        }
      }

      return next;
    });
    recordTelemetryTool({
      host: "copilot", sessionId, turnSeq: state.turnSeq,
      eventKey: hostEventKey || `${eventId}:${toolCallId}`, toolName, args, result,
      success: toolResultSucceeded(result), durationMs,
    });
    if (correctionRequired) {
      recordTelemetryState({
        host: "copilot", sessionId, turnSeq: state.turnSeq,
        eventKey: `${hostEventKey || `${eventId}:${toolCallId}`}:skill-correction-required`,
        kind: "skill_correction_required",
      });
    }
    if (correctionResolved) {
      recordTelemetryState({
        host: "copilot", sessionId, turnSeq: state.turnSeq,
        eventKey: `${hostEventKey || `${eventId}:${toolCallId}`}:skill-correction-resolved`,
        kind: "skill_correction_resolved",
      });
    }

    if (isCairnMcpTool(toolName) && !toolResultSucceeded(result)) return void emit({});
    const answer = typeof args.answer === "string" ? args.answer : "";
    const blocks = (await Promise.all(postToolFiles(toolName, answer).map(promptText))).filter((t) => t.length > 0);
    const text = internalContext(blocks.join("\n\n"));
    emit(text ? { additionalContext: text } : {});
    return;
  }

  if (mode === "agent-stop") {
    // agentStop enforces the required workflow and final completion gate. There is no subagent exemption:
    // a subagent runs Cairn exactly like a main agent, so it receives the same injected workflow at
    // user-prompt and is held to the same gate here. The previous carve-out identified subagents by the
    // SHAPE of their session id, which is a guess about the host rather than a fact from it; it matched
    // nothing in production, and where it did match it silently turned Cairn off for that agent.
    const stateId = turnScope(sessionId);
    const st = readLifecycle(stateId);
    if (!st.cairnToolObserved && st.cairnToolAttempted) {
      if (!st.cairnVisibilityNudged) {
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
      }
      // This branch returned before the nudge counter, so an unreachable Cairn blocked forever: the agent
      // is told to restart, cannot restart itself, and is asked again. Counting the block lets the same
      // OUTAGE_CAP that bounds the workflow gate end it, leaving the outage reported rather than looping.
      if (st.stopNudges < OUTAGE_CAP) {
        updateLifecycle(stateId, (current) => ({ ...current, stopNudges: current.stopNudges + 1 }));
        emit({
          decision: "block",
          reason: internalContext(CAIRN_VISIBILITY_REMINDER),
        });
        return;
      }
    }
    const openCreated = st.brainCreatedIds.filter((id) => !st.brainAnsweredIds.includes(id));
    const file = stopDecision({
      brainUsed: st.brainUsed,
      brainSearched: st.brainSearched,
      brainCreatedCount: st.brainCreatedIds.length,
      brainAnsweredCount: st.brainAnsweredIds.length,
      brainReusedCount: st.brainReusedIds.length,
      openCreatedCount: openCreated.length,
      rootSynthesized: st.rootSynthesized,
      skillUsed: st.skillUsed,
      stopNudges: st.stopNudges,
      strict: true,
      minimumBrainNodes: requiredBrainNodes(st.executionToolCalls),
      pendingSkillCorrections: st.invalidatedSkillIds.length,
      skillCorrectionNudges: st.skillCorrectionNudges,
    }).file;
    // Name the ACTUAL deficit. A generic "search the brain and create the root" re-block against a turn
    // that already did both sends the agent to redo finished work instead of the one thing still missing.
    const deficit = file === "turn-reminder.md"
      ? `\n\nThis turn already has: searched=${st.brainSearched}, created=${st.brainCreatedIds.length}, answered=${st.brainAnsweredIds.length}, reused=${st.brainReusedIds.length}, root synthesized=${st.rootSynthesized}. Required nodes for a turn that changed durable state: ${requiredBrainNodes(st.executionToolCalls)}. Supply only what is missing; do not repeat what is already done.${openCreated.length ? ` These nodes you created are still unanswered: ${openCreated.join(", ")}.` : ""}`
      : "";
    const text = file ? internalContext(`${await promptText(file)}${deficit}`) : "";
    if (text) {
      const skillCorrection = file === "skill-correction-reminder.md";
      updateLifecycle(stateId, () => ({
        ...st,
        stopNudges: skillCorrection ? st.stopNudges : st.stopNudges + 1,
        skillCorrectionNudges: skillCorrection
          ? st.skillCorrectionNudges + 1
          : st.skillCorrectionNudges,
        stopBlocked: true,
      }));
      recordTelemetryState({
        host: "copilot", sessionId, turnSeq: st.turnSeq,
        eventKey: hostEventKey || `${sessionId}:${st.turnSeq}:${skillCorrection ? "skill-correction" : "workflow"}`,
        // Ownership blocks are counted separately so the gate's real effect is measurable: itemCount is
        // how many questions the turn opened and left open, which is the number it must now go answer.
        kind: skillCorrection ? "skill_correction_blocked" : (openCreated.length ? "ownership_blocked" : "stop_blocked"),
        itemCount: openCreated.length,
      });
      emit({ decision: "block", reason: text });
      return;
    }
    const contractReason = contractStopReason(st.executionToolCalls > 0);
    if (contractReason) {
      // Declaring even once proves the tool is reachable, so any accumulated doubt is discarded.
      if (contractDeclared()) clearInstrumentDoubt(sessionId);
      else noteUndeclaredNudge(sessionId, st.turnSeq);
      const missing = !contractDeclared() && contractInstrumentMissing(sessionId);
      if (!missing) {
        noteContractNudge();
        recordTelemetryState({
          host: "copilot", sessionId, turnSeq: st.turnSeq,
          eventKey: hostEventKey || `${sessionId}:${st.turnSeq}:contract:${readContract()?.nudges ?? 0}`,
          kind: "contract_blocked",
        });
        emit({ decision: "block", reason: internalContext(contractReason) });
        return;
      }
      if (!contractInstrumentReported(sessionId)) {
        markContractInstrumentReported(sessionId);
        recordTelemetryState({
          host: "copilot", sessionId, turnSeq: st.turnSeq,
          eventKey: hostEventKey || `${sessionId}:${st.turnSeq}:contract-unavailable`,
          kind: "contract_unavailable",
        });
        emit({ decision: "block", reason: internalContext(CONTRACT_UNAVAILABLE_REASON) });
        return;
      }
      // Instrument absent and the user has already been told: release the turn rather than repeat a
      // demand this session provably cannot satisfy.
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
    if (completionContinuationEnabled() && !st.completionNudged) {
      updateLifecycle(stateId, () => ({ ...st, completionNudged: true, stopBlocked: true }));
      recordTelemetryState({
        host: "copilot", sessionId, turnSeq: st.turnSeq,
        eventKey: hostEventKey || `${sessionId}:${st.turnSeq}:completion`,
        kind: "completion_blocked",
      });
      const completion = st.skillUsed
        ? `${COMPLETION_REMINDER}\n\n${SKILL_APPLICATION_REMINDER}`
        : COMPLETION_REMINDER;
      emit({ decision: "block", reason: internalContext(completion) });
      return;
    }
    if (transcriptPath) {
      try {
        const { extractRunCopilot } = await import("../../skill/transcript-copilot");
        const { analyzeSkillReceipt, receiptScope, requiredStepCitations } = await import("../../core/skill-receipt");
        const { recordSkillReceiptTelemetry } = await import("../../core/skill-receipt-telemetry");
        // The receipt belongs to a reply, not to the whole turn. See receiptScope for why.
        const run = extractRunCopilot(transcriptPath);
        const output = run ? receiptScope(run.replies, run.output) : "";
        if (output) {
          const receipt = analyzeSkillReceipt(output, requiredStepCitations(st.selectedSkillIds));
          await recordSkillReceiptTelemetry({
            host: "copilot", sessionId, turnSeq: st.turnSeq,
            receiptKey: `${hostEventKey || `${sessionId}:${st.turnSeq}`}:skill-receipt`,
            receipt, selectedSkillIds: st.selectedSkillIds,
          });
        }
      } catch { /* receipt telemetry never blocks completion */ }
    }
    updateLifecycle(stateId, () => ({ ...st, pendingReviewIds: [], pendingReviews: [], stopBlocked: false }));
    if (process.env.AGENT_HARNESS === "1" && workflowReady({
      ...st,
      brainCreatedCount: st.brainCreatedIds.length,
      brainAnsweredCount: st.brainAnsweredIds.length,
      brainReusedCount: st.brainReusedIds.length,
      strict: true,
      minimumBrainNodes: requiredBrainNodes(st.executionToolCalls),
    })) {
      const receipt = complianceReceiptPath(sessionId);
      mkdirSync(dirname(receipt), { recursive: true });
      writeFileSync(receipt, JSON.stringify({
        sessionId,
        turnSeq: st.turnSeq,
        rootNodeId: st.rootNodeId,
        completedAt: new Date().toISOString(),
      }));
    }
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
  await runCopilotHook();
  // A timed-out stdin read leaves Bun.stdin.text()'s read handle open, which keeps this process (and any
  // host that waits for the hook to EXIT, not just for its stdout) alive until the host finally closes
  // stdin — the freeze we are guarding against. Flush our emitted JSON, then exit explicitly so the
  // dangling handle can never hold the host. The detached skill-learner is child.unref()'d, so it survives.
  await new Promise<void>((resolve) => process.stdout.write("", () => resolve()));
  process.exit(0);
}
