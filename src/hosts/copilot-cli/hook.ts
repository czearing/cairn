#!/usr/bin/env bun
// GitHub Copilot CLI hooks for Cairn. argv[2] selects the mode, one per hook event registered by
// setup.ts. As of Copilot CLI v1.0.66 the hook surface is much wider than the original two events,
// so Cairn now reaches near-parity with Claude Code (see docs.github.com/.../hooks-reference):
//
//   session-start  (sessionStart)        : inject the full brain workflow (user-message.md) once per session.
//   user-prompt    (userPromptSubmitted) : output is IGNORED by Copilot, so we cannot inject per prompt —
//                                          but the hook still RUNS, so we use it to RESET the per-turn latch.
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
//                                          nudges/turn). Auto-learns the turn as a FALLBACK only when
//                                          skill_review did not already review it.
//   subagent-start (subagentStart)       : additionalContext is PREPENDED to the subagent's own prompt —
//                                          the one channel that reaches a subagent's window (subagent-protocol.md).
//
// The only Claude behavior still unreachable on Copilot: per-PROMPT brain RECALL (userPromptSubmitted output
// is dropped). Per-event context that lives on PreToolUse (entry-format/orchestrate) is also context-unreachable;
// the brain_create gate enforces the format intent instead.
import { readFile } from "node:fs/promises";
import { readFileSync, writeFileSync, mkdirSync, appendFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const PROMPTS = new URL("../../../prompts/", import.meta.url);
const emit = (obj: object) => process.stdout.write(JSON.stringify(obj));
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
}
const freshTurn = (): TurnState => ({ brainUsed: false, skillUsed: false, reviewed: false, stopNudges: 0 });
const turnDir = () => join(homedir(), ".cairn", "copilot-turn");
const turnPath = (sid: string) =>
  join(turnDir(), `${(sid || "default").replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 128)}.json`);
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
  toolName: string;
  args: Record<string, unknown>;
  transcriptPath: string;
}
function parsePayload(raw: string): Payload {
  try {
    const j = JSON.parse(raw) as Record<string, unknown>;
    const rawArgs = j.toolArgs ?? j.tool_input;
    const args = (typeof rawArgs === "string" ? safeJson(rawArgs) : rawArgs) as Record<string, unknown> | undefined;
    return {
      sessionId: (j.sessionId as string) ?? (j.session_id as string) ?? "",
      toolName: (j.toolName as string) ?? (j.tool_name as string) ?? "",
      args: args ?? {},
      transcriptPath: (j.transcriptPath as string) ?? (j.transcript_path as string) ?? "",
    };
  } catch {
    return { sessionId: "", toolName: "", args: {}, transcriptPath: "" };
  }
}

// Fire the background skill learner over a finished turn's transcript, best-effort. Tags the spawned worker
// with CAIRN_LEARN_BACKEND=copilot so it parses Copilot's events.jsonl and grades via `copilot -p`. Returns
// true only when a worker was actually spawned (skills on, transcript present, under the concurrency cap), so
// callers can dedupe (the explicit skill_review path vs the agentStop fallback). Never throws or blocks.
async function fireLearner(transcriptPath: string): Promise<boolean> {
  if (!transcriptPath) return false;
  try {
    const { skillsEnabled } = await import("../../core/config");
    if (!skillsEnabled()) return false;
    process.env.CAIRN_LEARN_BACKEND = "copilot"; // the worker inherits this and picks the Copilot path
    const { learnFromTranscript } = await import("../../skill/learn");
    return learnFromTranscript(transcriptPath);
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
    emit(text ? { additionalContext: text } : {});
    return;
  }
  if (mode === "subagent-start") {
    const text = await promptText("subagent-protocol.md");
    emit(text ? { additionalContext: text } : {});
    return;
  }

  const raw = await Bun.stdin.text();
  debugLog(mode ?? "", raw);
  const { sessionId, toolName, args, transcriptPath } = parsePayload(raw);

  if (mode === "subagent-stop") {
    // No learning here. On Copilot a subagent's activity is interleaved in the PARENT session transcript (its
    // subagentStop transcriptPath is the parent, not an isolated subagent log), so firing the learner here
    // re-graded the parent turn and produced a duplicate run. Instead the agentStop learner segments the whole
    // turn and the reviewing agent splits out the subagent's deliverable (e.g. a story review) itself.
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
    writeTurn(sessionId, freshTurn());
    const wf = await promptText("user-message.md");
    emit(wf ? { additionalContext: wf } : {});
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
    const st = readTurn(sessionId);
    if (isTool(toolName, "brain_search") || isTool(toolName, "brain_mutate")) st.brainUsed = true;
    // skill_search means the agent pulled a skill's steps: the turn now OWES a skill_review, enforced at agentStop.
    if (isTool(toolName, "skill_search")) st.skillUsed = true;

    // The agent explicitly signalled a finished deliverable. Review the WHOLE turn log NOW (it already holds
    // any subagent's output, which a turn-end fire could miss when the work was backgrounded). Fire once per
    // turn; mark reviewed so agentStop does not learn the same turn again. If the fire was skipped (concurrency
    // cap), leave reviewed false so agentStop can still retry at turn end.
    if (isTool(toolName, "skill_review") && !st.reviewed) {
      if (await fireLearner(eventsPathForSession(sessionId))) st.reviewed = true;
    }

    const answer = typeof args.answer === "string" ? args.answer : "";
    const blocks = (await Promise.all(postToolFiles(toolName, answer).map(promptText))).filter((t) => t.length > 0);
    writeTurn(sessionId, st);

    const text = blocks.join("\n\n");
    emit(text ? { additionalContext: text } : {});
    return;
  }

  if (mode === "agent-stop") {
    // The learner must run ONCE per logical turn, at the turn's TRUE end. agentStop can fire several times for
    // one turn (each forced-continuation block ends in another agentStop), so we only learn on the agentStop
    // that ALLOWS (no block) — otherwise we'd grade an unfinished turn and create duplicate runs.
    if (process.env.CAIRN_COPILOT_NO_STOP) {
      const st = readTurn(sessionId);
      if (!st.reviewed) await fireLearner(transcriptPath);
      return void emit({});
    }
    const st = readTurn(sessionId);
    const { file } = stopDecision({ brainUsed: st.brainUsed, skillUsed: st.skillUsed, reviewed: st.reviewed, stopNudges: st.stopNudges });
    const text = file ? await promptText(file) : "";
    if (text) {
      writeTurn(sessionId, { ...st, stopNudges: st.stopNudges + 1 });
      emit({ decision: "block", reason: text }); // turn not done yet — don't learn an unfinished turn
      return;
    }
    // Fallback auto-learn ONLY when the agent did not already close a deliverable with skill_review this turn.
    if (!st.reviewed) await fireLearner(transcriptPath);
    emit({});
    return;
  }

  emit({});
}

if (import.meta.main) await main();
