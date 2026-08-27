#!/usr/bin/env bun
// GitHub Copilot CLI hooks for Cairn. argv[2] selects the mode, one per hook event registered by setup.ts.
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
import {
  type LifecycleTurn,
  isSystemEnvelope,
  lifecycleScope,
  readLifecycle,
  resetLifecycle,
  updateLifecycle,
} from "../../core/lifecycle";
import { recordHostEvent } from "../../core/host-events";
import {
  beginTelemetryRun,
  finishTelemetryRun,
  recordTelemetry,
  recordTelemetryState,
  recordTelemetryTool,
} from "../../core/telemetry-record";
import { promptFingerprint } from "../../core/release";
import { postToolPromptFiles } from "../../inject/post-tool";
import { completionContinuationEnabled } from "./completion-gate";
import {
  CONTRACT_DECLARE_REASON,
  CONTRACT_UNAVAILABLE_REASON,
  clearInstrumentDoubt,
  contractBlockedAttempts,
  contractInstrumentMissing,
  contractInstrumentReported,
  markContractInstrumentReported,
  noteContractBlocked,
  noteUndeclaredNudge,
  sessionStatePath,
  declareContract,
  satisfyCriterion,
  contractDeclared,
  contractExhausted,
  clearContract,
  contractStopReason,
  noteContractNudge,
  readContract,
  recordObservedRun,
  formatPlanSummary,
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
const CAIRN_VISIBILITY_REMINDER =
  "Cairn's required brain tools failed in this session. The CLI may have cached an earlier MCP startup failure. Final submission remains blocked: tell the user to run `/restart` once, then complete the required Cairn Brain workflow.";

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
    return await readFile(new URL(file, PROMPTS), "utf8");
  } catch {
    return "";
  }
};
const workflowPrompt = (turnSeq = 1): Promise<string> => {
  if (process.env.AGENT_HARNESS === "1") {
    return promptText("harness-workflow.md");
  }
  return promptText(turnSeq <= 1 ? "user-message.md" : "workflow-reminder.md");
};

export const isTool = (name: string, want: string): boolean =>
  name === want || name.endsWith(want) || name.includes(want);

const isCairnMcpTool = (name: string): boolean => [
  "brain_search", "brain_create", "brain_mutate", "brain_delete", "contract", "plan",
].some((tool) => isTool(name, tool));
const isTask = (name: string): boolean => /^(task|agent)$/i.test(name) || name === "Task" || name === "Agent";

export function postToolFiles(toolName: string, answer: string): string[] {
  return postToolPromptFiles(toolName, answer);
}

export const STOP_CAP = 2;
export const OUTAGE_CAP = STOP_CAP * 2;

export interface WorkflowEvidence {
  brainUsed: boolean;
  brainSearched?: boolean;
  brainCreatedCount?: number;
  brainAnsweredCount?: number;
  brainReusedCount?: number;
  openCreatedCount?: number;
  rootSynthesized?: boolean;
  stopNudges: number;
  strict?: boolean;
  minimumBrainNodes?: number;
  executionToolCount?: number;
  planDeclared?: boolean;
}

export function stopDecision(s: WorkflowEvidence): { file: string } {
  if (s.stopNudges >= OUTAGE_CAP) return { file: "" };
  if (!s.planDeclared && s.executionToolCount === 0) return { file: "" };
  if (s.strict && !brainWorkComplete(s)) {
    return { file: (s.brainSearched && (s.brainCreatedCount ?? 0) === 0)
      ? "brain-reuse-reminder.md"
      : "turn-reminder.md" };
  }
  if (!s.brainUsed) return { file: "turn-reminder.md" };
  return { file: "" };
}

function brainWorkComplete(s: WorkflowEvidence): boolean {
  if (!s.brainSearched) return false;
  const created = s.brainCreatedCount ?? 0;
  const reused = s.brainReusedCount ?? 0;
  if (created === 0) return reused > 0;
  const floor = s.stopNudges >= STOP_CAP ? 1 : (s.minimumBrainNodes ?? 1);
  const owed = (s.openCreatedCount ?? Math.max(0, created - (s.brainAnsweredCount ?? 0))) > 0;
  return created + reused >= floor && !owed && Boolean(s.rootSynthesized);
}

const READ_ONLY_TOOLS = /^(read|view|glob|grep|rg|search|tool_search|web_fetch|web_search|fetch_copilot_cli_documentation|list_|get_|sql|session_store_sql|ask_user|vote_memory|store_memory)/i;
const FILE_MUTATION_TOOLS = /^(edit|create|write|replace|patch|new_file)/i;
const SHELL_MUTATION = /(?:^|[;&|]\s*)(?:set-content|add-content|out-file|remove-item|move-item|copy-item|rename-item|new-item)\b|\bgit\s+(?:add|commit|push|checkout|switch|reset|clean|merge|rebase|tag)\b|\baz\s+repos\s+pr\s+(?:create|update)\b|\baz\s+devops\s+invoke\b[\s\S]*?--http-method\s+(?:post|put|patch|delete)\b|(?:^|[^<=])>{1,2}(?![>&])/i;
const workflowReady = (s: WorkflowEvidence): boolean => brainWorkComplete(s);

export function isFileMutationTool(toolName: string): boolean {
  return FILE_MUTATION_TOOLS.test(toolName);
}

// A deny that lists every step leaves the agent guessing which one it still owes, so it retries the
// blocked call instead of the missing step. Name the single outstanding step, in the same order
// brainWorkComplete checks them, so the next action is unambiguous.
export function workflowDeficit(s: WorkflowEvidence): string {
  if (!s.brainSearched) return "call `brain_search` to check for relevant prior knowledge";
  const created = s.brainCreatedCount ?? 0;
  const reused = s.brainReusedCount ?? 0;
  if (created === 0 && reused === 0) {
    return "call `brain_create` to record the open question this work answers";
  }
  const floor = s.stopNudges >= STOP_CAP ? 1 : (s.minimumBrainNodes ?? 1);
  const owed = s.openCreatedCount ?? Math.max(0, created - (s.brainAnsweredCount ?? 0));
  if (owed > 0) {
    return `answer ${owed} open node(s) with \`brain_mutate\`, supplying an answer and a citation`;
  }
  if (created + reused < floor) {
    return `create ${floor - (created + reused)} more decomposition node(s) with \`brain_create\``;
  }
  if (!s.rootSynthesized) return "synthesize the root node with `brain_mutate`";
  return "finish the remaining Cairn workflow step";
}

export function requiredBrainNodes(executionToolCalls: number): number {
  const full = Math.max(1, Number(process.env.CAIRN_MIN_BRAIN_NODES || "1"));
  const readOnly = Math.max(1, Number(process.env.CAIRN_MIN_BRAIN_NODES_READONLY || "1"));
  return executionToolCalls > 0 ? full : Math.min(readOnly, full);
}

export function countsAsExecution(toolName: string, args: Record<string, unknown> = {}): boolean {
  const command = typeof args.command === "string" ? args.command : "";
  const readOnlyShell = /powershell|bash|shell/i.test(toolName) && !SHELL_MUTATION.test(command);
  return !isCairnMcpTool(toolName)
    && !READ_ONLY_TOOLS.test(toolName)
    && !readOnlyShell;
}

const DURABLE_SHELL_VERB =
  /\bgit\s+(?:add|commit|push|checkout|switch|reset|clean|merge|rebase|tag)\b|(?:^|[;&|]\s*)(?:move-item|copy-item|rename-item|stop-process|start-process)\b|\baz\s+/i;
const WRITE_VERB = /(?:^|[;&|]\s*)(?:set-content|add-content|out-file|new-item)\b|(?:^|[^<])>{1,2}(?![>&])/i;
const REMOVE_VERB = /(?:^|[;&|]\s*)remove-item\b/i;
const SCRATCH_LOCATION = /\$env:TEMP|%TEMP%|[\\/]tmp[\\/]|[\\/]temp[\\/]|session-state/i;

const fileNames = (text: string): string[] =>
  [...text.matchAll(/[\w$.:\\/-]*[\w-]+\.[a-z0-9]{1,6}\b/gi)]
    .map((match) => match[0].toLowerCase().replace(/^.*[\\/]/, ""));

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
      `Blocked by the Cairn workflow. One step is outstanding: ${workflowDeficit(state)}.`
      + " Do that next rather than retrying this call. The requested side effect was not executed.",
  };
}

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

const turnScope = (sessionId: string, _agentId = "") => lifecycleScope("copilot", sessionId);

const safeJson = (s: string): unknown => {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
};

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

export function extractResultNodeId(result: unknown, args: Record<string, unknown> = {}): string {
  if (typeof args.id === "string" && args.id.trim()) return args.id.trim();
  if (!result || typeof result !== "object") return "";
  const obj = result as Record<string, unknown>;
  if (typeof obj.id === "string" && obj.id.trim()) return obj.id.trim();

  if (Array.isArray(obj.content) && obj.content[0] && typeof obj.content[0] === "object") {
    const text = String((obj.content[0] as { text?: unknown }).text ?? "");
    try {
      const parsed = JSON.parse(text) as { id?: unknown };
      if (typeof parsed?.id === "string" && parsed.id.trim()) return parsed.id.trim();
    } catch {
      const match = text.match(/"id"\s*:\s*"([^"]+)"/);
      if (match && match[1]) return match[1];
    }
  }

  const textVal = typeof obj.textResultForLlm === "string" ? obj.textResultForLlm
    : typeof obj.text === "string" ? obj.text : "";
  if (textVal) {
    try {
      const parsed = JSON.parse(textVal) as { id?: unknown };
      if (typeof parsed?.id === "string" && parsed.id.trim()) return parsed.id.trim();
    } catch {
      const match = textVal.match(/"id"\s*:\s*"([^"]+)"/);
      if (match && match[1]) return match[1];
    }
  }

  return "";
}

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

export async function runCopilotHook(): Promise<void> {
  if (process.env.CAIRN_SKIP_HOOKS === "1" || process.env.CAIRN_REVIEWER === "1") {
    process.stdout.write("{}");
    return;
  }
  process.env.CAIRN_READONLY = "1";
  const mode = process.argv[2];
  const raw = await readStdin();
  debugLog(mode ?? "", raw);
  const rawPayload = safeJson(raw);
  let hostEventKey = "";
  try { hostEventKey = recordHostEvent("copilot", mode ?? "", raw, rawPayload); } catch { /* event indexing never blocks the host */ }
  const {
    sessionId, agentId, toolName, args, result, prompt,
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
    const text = await workflowPrompt(1);
    emit(text ? { additionalContext: internalContext(text) } : {});
    return;
  }
  if (mode === "subagent-start") {
    const text = await promptText("subagent-protocol.md");
    emit(text ? { additionalContext: internalContext(text) } : {});
    return;
  }
  if (mode === "subagent-stop") {
    resetLifecycle(turnScope(sessionId));
    emit({});
    return;
  }

  if (mode === "user-prompt") {
    try {
      const { healReleaseLabel } = await import("../../core/runtime-identity");
      const { releaseVersion } = await import("../../core/release");
      healReleaseLabel(releaseVersion);
    } catch { /* a stale release label must never block a turn */ }

    const stateId = turnScope(sessionId);
    if (!shouldStartUserTurn(prompt)) return void emit({});
    rmSync(complianceReceiptPath(sessionId), { force: true });
    clearContract(sessionId);
    try { (await import("../../core/auto-update")).maybeAutoUpdate(); }
    catch { /* self-update is background work and never blocks a turn */ }
    resetLifecycle(stateId);
    const state = readLifecycle(stateId);
    if (emittedUsage) emittedUsage.turnSeq = state.turnSeq;
    const wf = await workflowPrompt(state.turnSeq);
    beginTelemetryRun({
      host: "copilot", sessionId, turnSeq: state.turnSeq,
      promptHash: promptFingerprint(wf),
      injectedChars: internalContext(wf).length, model,
    });
    emit(wf ? { additionalContext: internalContext(wf) } : {});
    return;
  }

  if (mode === "pre-tool") {
    if (isCairnMcpTool(toolName)) {
      updateLifecycle(turnScope(sessionId, agentId), (current) => ({ ...current, cairnToolAttempted: true }));
    }
    let decision: { deny: boolean; reason?: string } = { deny: false };
    try {
      if (process.env.AGENT_HARNESS === "1" && !agentId) {
        const state = readLifecycle(turnScope(sessionId));
        decision = workflowActionDecision(toolName, {
          brainUsed: state.createdCount > 0 || state.reusedCount > 0 || state.searched,
          brainSearched: state.searched,
          brainCreatedCount: state.createdCount,
          brainAnsweredCount: state.answeredCount,
          brainReusedCount: state.reusedCount,
          openCreatedCount: state.openCreatedNodeIds.length,
          rootSynthesized: state.rootSynthesized,
          stopNudges: state.stopNudges,
          strict: true,
          minimumBrainNodes: requiredBrainNodes(1),
        }, args);
        if (decision.deny) {
          emit({ permissionDecision: "deny", permissionDecisionReason: decision.reason });
          return;
        }
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

    if (!decision.deny && !isTask(toolName) && isFileMutationTool(toolName)) {
      if (!contractDeclared(sessionId) && !contractExhausted(sessionId) && !contractInstrumentMissing(sessionId)) {
        noteContractBlocked(sessionId);
        emit({ permissionDecision: "deny", permissionDecisionReason: CONTRACT_DECLARE_REASON });
        return;
      }
      const st = readLifecycle(turnScope(sessionId, agentId));
      if (!st.searched) {
        emit({
          permissionDecision: "deny",
          permissionDecisionReason: "Research in Cairn first: call `brain_search` to check for relevant prior knowledge before modifying files or executing changes.",
        });
        return;
      }
      if (st.createdCount === 0 && st.reusedCount === 0) {
        emit({
          permissionDecision: "deny",
          permissionDecisionReason: "Decompose your task in Cairn first: declare your root question with `brain_create` (or reuse a covering node with `brain_mutate`) before modifying files or executing changes.",
        });
        return;
      }
    }
    emit(decision.deny ? { permissionDecision: "deny", permissionDecisionReason: decision.reason } : {});
    return;
  }

  if (mode === "post-tool") {
    const stateId = turnScope(sessionId, agentId);
    let contractResult: { error?: string; criteria?: unknown[]; remaining?: string[] } | undefined;
    if ((isTool(toolName, "contract") || isTool(toolName, "plan")) && toolResultSucceeded(result)) {
      const checks = (Array.isArray(args.tasks) ? args.tasks : Array.isArray(args.checks) ? args.checks : [])
        .filter((check): check is string => typeof check === "string");
      const satisfied = typeof args.completed === "string" ? args.completed
        : typeof args.satisfied === "string" ? args.satisfied : "";
      const evidence = typeof args.evidence === "string" ? args.evidence : "";
      if (checks.length > 0) {
        contractResult = declareContract(checks, sessionId);
      }
      if (satisfied) {
        contractResult = satisfyCriterion(satisfied, evidence, sessionId);
      }
    }
    if (typeof args.command === "string") {
      recordObservedRun(args.command, toolResultSucceeded(result) && !reportedNonZeroExit(result), sessionId);
    }

    const state = updateLifecycle(stateId, (current) => {
      const next = { ...current };
      const succeeded = toolResultSucceeded(result);
      if (isCairnMcpTool(toolName)) next.cairnToolAttempted = true;
      if (isCairnMcpTool(toolName) && succeeded) next.cairnToolObserved = true;
      if (changesDurableState(toolName, args)) next.executionToolCount += 1;
      if (isTool(toolName, "brain_search") && succeeded) {
        next.searched = true;
      }
      if (isTool(toolName, "brain_create") && succeeded) {
        const id = extractResultNodeId(result, args);
        if (id) {
          next.createdNodeIds = [...new Set([...next.createdNodeIds, id])];
          next.openCreatedNodeIds = [...new Set([...next.openCreatedNodeIds, id])];
          next.createdCount = next.createdNodeIds.length;
        }
      }
      if (isTool(toolName, "brain_mutate") && succeeded) {
        const id = extractResultNodeId(result, args);
        if (id && !next.createdNodeIds.includes(id)) {
          next.reusedNodeIds = [...new Set([...next.reusedNodeIds, id])];
          next.reusedCount = next.reusedNodeIds.length;
        }
        if (typeof args.answer === "string" && args.answer.trim()) {
          if (id) {
            next.answeredCount += 1;
            next.openCreatedNodeIds = next.openCreatedNodeIds.filter((nodeId) => nodeId !== id);
          }
          next.rootSynthesized = true;
        }
      }
      if (isTool(toolName, "brain_delete") && succeeded) {
        const id = extractResultNodeId(result, args);
        if (id) {
          next.createdNodeIds = next.createdNodeIds.filter((nodeId) => nodeId !== id);
          next.openCreatedNodeIds = next.openCreatedNodeIds.filter((nodeId) => nodeId !== id);
          next.reusedNodeIds = next.reusedNodeIds.filter((nodeId) => nodeId !== id);
          next.createdCount = next.createdNodeIds.length;
          next.reusedCount = next.reusedNodeIds.length;
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
    if (contractResult) {
      blocks.unshift(contractResult.error
        ? `Plan update failed: ${contractResult.error}`
        : `Plan state:\n${formatPlanSummary(sessionId)}`);
    }
    const text = internalContext(blocks.join("\n\n"));
    emit(text ? { additionalContext: text } : {});
    return;
  }

  if (mode === "agent-stop") {
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
      if (st.stopNudges < OUTAGE_CAP) {
        updateLifecycle(stateId, (current) => ({ ...current, stopNudges: current.stopNudges + 1 }));
        emit({
          decision: "block",
          reason: internalContext(CAIRN_VISIBILITY_REMINDER),
        });
        return;
      }
    }

    const brainUsed = st.createdCount > 0 || st.reusedCount > 0 || st.searched;
    const isPlanDeclared = contractDeclared(sessionId);
    const file = stopDecision({
      brainUsed,
      brainSearched: st.searched,
      brainCreatedCount: st.createdCount,
      brainAnsweredCount: st.answeredCount,
      brainReusedCount: st.reusedCount,
      openCreatedCount: st.openCreatedNodeIds.length,
      rootSynthesized: st.rootSynthesized,
      stopNudges: st.stopNudges,
      strict: true,
      minimumBrainNodes: requiredBrainNodes(st.executionToolCount),
      executionToolCount: st.executionToolCount,
      planDeclared: isPlanDeclared,
    }).file;

    const deficit = file === "turn-reminder.md" && st.openCreatedNodeIds.length > 0
      ? `\n\nUnresolved nodes to answer: ${st.openCreatedNodeIds.join(", ")}.`
      : "";
    const text = file ? internalContext(`${await promptText(file)}${deficit}`) : "";
    if (text) {
      updateLifecycle(stateId, () => ({
        ...st,
        stopNudges: st.stopNudges + 1,
        stopBlocked: true,
      }));
      recordTelemetryState({
        host: "copilot", sessionId, turnSeq: st.turnSeq,
        eventKey: hostEventKey || `${sessionId}:${st.turnSeq}:workflow`,
        kind: st.openCreatedNodeIds.length ? "ownership_blocked" : "stop_blocked",
        itemCount: st.openCreatedNodeIds.length,
      });
      emit({ decision: "block", reason: text });
      return;
    }

    // A turn whose every execution tool was denied never increments the lifecycle counter, so treat
    // blocked attempts as evidence the turn tried to act. Otherwise the demand is never ledgered, the
    // release below can never be earned, and a session that cannot declare a contract stays bricked.
    const attemptedToAct = st.executionToolCount > 0 || contractBlockedAttempts(sessionId) > 0;
    const contractReason = contractStopReason(attemptedToAct, sessionId);
    if (contractReason) {
      if (contractDeclared(sessionId)) clearInstrumentDoubt(sessionId);
      else noteUndeclaredNudge(sessionId, st.turnSeq);
      const missing = !contractDeclared(sessionId) && contractInstrumentMissing(sessionId);
      if (!missing) {
        noteContractNudge(sessionId);
        recordTelemetryState({
          host: "copilot", sessionId, turnSeq: st.turnSeq,
          eventKey: hostEventKey || `${sessionId}:${st.turnSeq}:contract:${readContract(sessionId)?.nudges ?? 0}`,
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
    }

    if (process.env.AGENT_HARNESS === "1" && harnessTurnDeferred()) {
      finishTelemetryRun({
        host: "copilot", sessionId, turnSeq: st.turnSeq, completed: false,
        workflowPassed: brainUsed,
        brainUsed, stopNudges: st.stopNudges,
      });
      emit({});
      return;
    }

    if (completionContinuationEnabled() && st.executionToolCount > 0 && !st.completionNudged) {
      updateLifecycle(stateId, (current) => ({ ...current, completionNudged: true }));
      recordTelemetryState({
        host: "copilot", sessionId, turnSeq: st.turnSeq,
        eventKey: hostEventKey || `${sessionId}:${st.turnSeq}:completion`,
        kind: "completion_blocked",
      });
      emit({ decision: "block", reason: internalContext(COMPLETION_REMINDER) });
      return;
    }

    if (workflowReady({
      brainUsed,
      brainSearched: st.searched,
      brainCreatedCount: st.createdCount,
      brainAnsweredCount: st.answeredCount,
      brainReusedCount: st.reusedCount,
      openCreatedCount: st.openCreatedNodeIds.length,
      rootSynthesized: st.rootSynthesized,
      stopNudges: st.stopNudges,
      strict: true,
      minimumBrainNodes: requiredBrainNodes(st.executionToolCount),
    })) {
      const receipt = complianceReceiptPath(sessionId);
      try {
        mkdirSync(dirname(receipt), { recursive: true });
        writeFileSync(receipt, JSON.stringify({
          sessionId,
          turnSeq: st.turnSeq,
          rootNodeId: st.createdNodeIds[0] || st.reusedNodeIds[0] || "root",
          completedAt: new Date().toISOString(),
        }));
      } catch { /* receipt write is best-effort */ }
    }

    finishTelemetryRun({
      host: "copilot", sessionId, turnSeq: st.turnSeq, completed: true,
      workflowPassed: brainUsed,
      brainUsed, stopNudges: st.stopNudges,
    });
    emit({});
    return;
  }
}

if (import.meta.main) {
  await runCopilotHook();
}
