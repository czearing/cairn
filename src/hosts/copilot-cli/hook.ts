#!/usr/bin/env bun
// GitHub Copilot CLI hooks for Cairn. argv[2] selects the mode, one per hook event registered by
// setup.ts. As of Copilot CLI v1.0.66 the hook surface is much wider than the original two events,
// so Cairn now reaches near-parity with Claude Code (see docs.github.com/.../hooks-reference):
//
//   session-start  (sessionStart)        : inject the full brain workflow (user-message.md) once per session.
//   user-prompt    (userPromptSubmitted) : inject the workflow and reset the per-turn latch.
//   pre-tool       (preToolUse)          : gate a brain_create (deny closed-question / root-only-branch).
//                                          preToolUse has no additionalContext channel, so entry-format.md /
//                                          orchestrate.md cannot be injected here — only allow/deny/modify.
//   post-tool      (postToolUse)         : after a brain_* or Task tool, inject the matching reminder, and
//                                          record brain usage for this turn (drives the agentStop gate). Also
//                                          the skill_review trigger: when the agent signals a finished
//                                          deliverable, review the whole turn log now (catches backgrounded
//                                          subagent output a turn-end fire would miss).
//   agent-stop     (agentStop)           : the Stop equivalent — decision:"block" forces another turn. Used
//                                          for turn-reminder.md (brain unused) and skill-review.md (a skill
//                                          was used but not submitted via skill_review). Loop-bounded (max 2
//                                          nudges/turn).
//   subagent-start (subagentStart)       : additionalContext is PREPENDED to the subagent's own prompt —
//                                          the one channel that reaches a subagent's window (subagent-protocol.md).
//
// Per-event context on PreToolUse remains unreachable; the brain_create gate enforces the format intent instead.
import { readFile } from "node:fs/promises";
import {
  appendFileSync,
  closeSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { isSystemEnvelope } from "../../skill/noise";

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
export function stopDecision(s: { brainUsed: boolean; skillUsed: boolean; reviewed: boolean; stopNudges: number }): {
  file: string;
} {
  if (s.stopNudges >= STOP_CAP) return { file: "" };
  if (!s.skillUsed) return { file: "skill-search-reminder.md" };
  if (!s.brainUsed) return { file: "turn-reminder.md" };
  if (s.skillUsed && !s.reviewed) return { file: "skill-review.md" };
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

// ── Per-turn state (drives the agentStop gate without parsing Copilot's transcript) ─────────────
// A turn runs from userPromptSubmitted to agentStop. Keyed by sessionId, we record whether the brain was
// used, whether the agent used a skill this turn (skill_search), and whether it closed the deliverable with
// skill_review — so agentStop can nag an un-reviewed skill turn and never fire a duplicate learn.
interface TurnState {
  brainUsed: boolean;
  skillUsed: boolean;
  reviewed: boolean;
  stopNudges: number;
  stopBlocked: boolean;
  userMarker: string;
}
const freshTurn = (): TurnState => ({
  brainUsed: false,
  skillUsed: false,
  reviewed: false,
  stopNudges: 0,
  stopBlocked: false,
  userMarker: "",
});
const turnDir = () => join(homedir(), ".cairn", "copilot-turn");
const turnPath = (sid: string) =>
  join(turnDir(), `${(sid || "default").replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 128)}.json`);
const turnScope = (sessionId: string, agentId: string): string => agentId ? `${sessionId}--${agentId}` : sessionId;
function readTurn(sid: string): TurnState {
  try {
    return { ...freshTurn(), ...(JSON.parse(readFileSync(turnPath(sid), "utf8")) as Partial<TurnState>) };
  } catch {
    return freshTurn();
  }
}
function writeTurn(sid: string, s: TurnState): void {
  try {
    mkdirSync(turnDir(), { recursive: true });
    writeFileSync(turnPath(sid), JSON.stringify(s));
  } catch {
    /* state is best-effort: a miss only weakens a nudge, never breaks the turn */
  }
}

export function synchronizeTurnState(
  state: TurnState,
  userMarker: string,
): TurnState {
  if (!userMarker || state.userMarker === userMarker) return state;
  return { ...freshTurn(), userMarker };
}

function latestUserMarker(transcriptPath: string): string {
  if (!transcriptPath) return "";
  let fd: number | undefined;
  try {
    fd = openSync(transcriptPath, "r");
    const size = fstatSync(fd).size;
    const length = Math.min(size, 1024 * 1024);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    return latestHumanUserMarker(
      buffer.toString("utf8").split(/\r?\n/),
    );
  } catch {
    return "";
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function latestHumanUserMarker(lines: string[]): string {
  for (const line of [...lines].reverse()) {
    if (!line.includes('"type":"user.message"')) continue;
    try {
      const event = JSON.parse(line) as {
        id?: string;
        timestamp?: string;
        data?: { content?: string };
      };
      if (isSystemEnvelope(event.data?.content || "")) continue;
      return event.id || event.timestamp || "";
    } catch {
      continue;
    }
  }
  return "";
}

// ── stdin payload parsing (camelCase config ⇒ camelCase payloads; snake_case tolerated) ─────────
const safeJson = (s: string): unknown => {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
};
interface Payload {
  sessionId: string;
  agentId: string;
  toolName: string;
  args: Record<string, unknown>;
  transcriptPath: string;
  prompt: string;
}
function parsePayload(raw: string): Payload {
  try {
    const j = JSON.parse(raw) as Record<string, unknown>;
    const rawArgs = j.toolArgs ?? j.tool_input;
    const args = (typeof rawArgs === "string" ? safeJson(rawArgs) : rawArgs) as Record<string, unknown> | undefined;
    return {
      sessionId: (j.sessionId as string) ?? (j.session_id as string) ?? "",
      agentId: (j.agentId as string) ?? (j.agent_id as string) ?? "",
      toolName: (j.toolName as string) ?? (j.tool_name as string) ?? "",
      args: args ?? {},
      transcriptPath: (j.transcriptPath as string) ?? (j.transcript_path as string) ?? "",
      prompt: (j.prompt as string) ?? "",
    };
  } catch {
    return { sessionId: "", agentId: "", toolName: "", args: {}, transcriptPath: "", prompt: "" };
  }
}

export const shouldStartUserTurn = (prompt: string): boolean =>
  !isSystemEnvelope(prompt);

// Durably enqueue the latest matching skill_review event. Capacity only delays the queued job; acceptance
// marks the turn reviewed immediately so agentStop never asks the agent to resubmit work it already submitted.
async function queueLatestReview(
  transcriptPath: string,
  sessionId: string,
  options: { skillId?: string; agentId?: string; subagentOnly?: boolean } = {}
): Promise<boolean> {
  if (!transcriptPath || !sessionId) return false;
  try {
    const { skillsEnabled } = await import("../../core/config");
    if (!skillsEnabled()) return false;
    const { learnLatestCopilotReview } = await import("../../skill/learn");
    return learnLatestCopilotReview(transcriptPath, sessionId, options);
  } catch {
    return false; // skills are best-effort
  }
}

// Copilot writes each session's turn log to ~/.copilot/session-state/<sessionId>/events.jsonl. postToolUse
// (where skill_review is detected) carries only the sessionId, not a transcript path, so we reconstruct the
// events-log path from it to review the whole turn — including any subagent output already written there.
function eventsPathForSession(sessionId: string): string {
  return join(homedir(), ".copilot", "session-state", sessionId, "events.jsonl");
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

  if (mode === "session-start") {
    const text = await promptText("user-message.md");
    emit(text ? { additionalContext: internalContext(text) } : {});
    return;
  }
  if (mode === "subagent-start") {
    const text = await promptText("subagent-protocol.md");
    emit(text ? { additionalContext: internalContext(text) } : {});
    return;
  }

  const raw = await readStdin();
  debugLog(mode ?? "", raw);
  const { sessionId, agentId, toolName, args, transcriptPath, prompt } = parsePayload(raw);

  if (mode === "subagent-stop") {
    const path = transcriptPath || eventsPathForSession(sessionId);
    if (await queueLatestReview(path, sessionId, { agentId: agentId || undefined, subagentOnly: true })) {
      const st = synchronizeTurnState(
        readTurn(sessionId),
        latestUserMarker(path),
      );
      st.skillUsed = true;
      st.reviewed = true;
      writeTurn(sessionId, st);
    }
    emit({});
    return;
  }

  if (mode === "user-prompt") {
    // TURN-START injection, exactly like Claude Code's UserPromptSubmit: emit the full workflow so it is
    // in front of the model BEFORE it acts, on EVERY prompt — this is what keeps it from decaying or being
    // dropped on compaction. Empirically verified on Copilot CLI v1.0.66: userPromptSubmitted additionalContext
    // IS delivered to the model (the published hooks reference says "Output processed: No", but a live marker
    // test proved otherwise; sessionStart still injects a baseline copy in case a future version regresses).
    // Also reset the per-turn latch so the agentStop gate is scoped to this turn.
    //
    // Copilot can re-fire this hook for a blocked continuation. Preserve the cap only for that continuation,
    // then let the next genuine user turn start with a fresh budget.
    if (!shouldStartUserTurn(prompt)) return void emit({});
    const prev = readTurn(sessionId);
    writeTurn(sessionId, { ...freshTurn(), stopNudges: prev.stopBlocked ? prev.stopNudges : 0 });
    const wf = await promptText("user-message.md");
    emit(wf ? { additionalContext: internalContext(wf) } : {});
    return;
  }

  if (mode === "pre-tool") {
    // preToolUse command hooks are FAIL-CLOSED (a crash denies the tool), so default to allow and only
    // ever deny on an explicit gate match.
    if (process.env.CAIRN_COPILOT_NO_GATE) return void emit({});
    let decision: { deny: boolean; reason?: string } = { deny: false };
    try {
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
    const path = transcriptPath || eventsPathForSession(sessionId);
    const st = synchronizeTurnState(
      readTurn(stateId),
      latestUserMarker(path),
    );
    if (isTool(toolName, "brain_search") || isTool(toolName, "brain_mutate")) st.brainUsed = true;
    // skill_search / skill_create mean the agent is doing skill work: the turn now OWES a skill_review, which
    // the agentStop gate enforces.
    if (isTool(toolName, "skill_search") || isTool(toolName, "skill_create")) st.skillUsed = true;

    // The agent DECLARED a finished deliverable for skill `id`. Review the WHOLE turn log NOW (it already
    // holds any subagent's output, which a turn-end fire could miss when the work was backgrounded). Each
    // skill_review fires its own learner (a turn with two deliverables = two calls, two ids); mark reviewed
    // so agentStop does not nag, and skillUsed so the gate is satisfied.
    if (isTool(toolName, "skill_review")) {
      const id = typeof args.id === "string" ? args.id : "";
      st.skillUsed = true;
      if (await queueLatestReview(path, sessionId, { skillId: id, agentId: agentId || undefined })) st.reviewed = true;
    }

    const answer = typeof args.answer === "string" ? args.answer : "";
    const blocks = (await Promise.all(postToolFiles(toolName, answer).map(promptText))).filter((t) => t.length > 0);
    writeTurn(stateId, st);

    const text = internalContext(blocks.join("\n\n"));
    emit(text ? { additionalContext: text } : {});
    return;
  }

  if (mode === "agent-stop") {
    // Learning is now AGENT-DRIVEN: skill_review fires the learner mid-turn with the declared label. agentStop
    // no longer auto-learns (there is no label to grade against here) — it only NAGS: brain unused, or a skill
    // was used but the deliverable was not submitted via skill_review. Bounded to STOP_CAP nudges/turn.
    if (process.env.CAIRN_COPILOT_NO_STOP) return void emit({});
    const path = transcriptPath || eventsPathForSession(sessionId);
    const st = synchronizeTurnState(
      readTurn(sessionId),
      latestUserMarker(path),
    );
    const { file } = stopDecision({ brainUsed: st.brainUsed, skillUsed: st.skillUsed, reviewed: st.reviewed, stopNudges: st.stopNudges });
    const text = file ? internalContext(await promptText(file)) : "";
    if (text) {
      writeTurn(sessionId, { ...st, stopNudges: st.stopNudges + 1, stopBlocked: true });
      emit({ decision: "block", reason: text }); // nudge the agent to review before ending
      return;
    }
    if (st.stopBlocked) writeTurn(sessionId, { ...st, stopBlocked: false });
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
