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

// Fired once per turn (PreToolUse) if the agent reaches for an action tool without having called skill_search.
const SKILL_REMINDER =
  "Before acting, search your learned skills: call skill_search with a short description of this task. If a curated skill matches, follow its steps instead of redoing the work. You will not be reminded again this turn.";

// Awaited write so the buffer is fully flushed before we force-exit (a bare process.exit() right
// after process.stdout.write() can truncate piped output).
const emit = (obj: object) => Bun.write(Bun.stdout, JSON.stringify(obj));

async function main(): Promise<void> {
  // Imported here, not at top level, so a module that fails to load is caught by the guard below
  // rather than crashing the process before it can exit cleanly.
  const { inject } = await import("../../inject/inject");
  const { getEventName, normalizeClaudeCode } = await import("./normalize");
  const { respond, denyPreTool, modifyPreTool } = await import("./respond");
  const { rootId, openBranchExists } = await import("../../core/audit");

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

  // A subagent (Task tool) finished. SubagentStop is a PARENT-session event. Learning is now agent-driven (the
  // agent calls skill_review after the subagent returns), so we do NOT auto-learn here — we only skip the
  // Stop-shaped nudge that would otherwise fire back into a finished subagent.
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

  // Subagent prompt injection. A subagent does NOT inherit the cairn prompt (SessionStart does not fire for
  // subagents, tested 2026-06-29). The ONE channel that reaches a subagent's own context is its Task prompt, so
  // when the parent spawns a Task we rewrite the prompt (PreToolUse updatedInput) to prepend the cairn protocol,
  // giving every subagent the skill_search + brain behavior. The orchestrate.md reminder still rides
  // back to the parent as additionalContext. Best-effort: on any failure, fall through to normal handling.
  if (event.kind === "tool_pending" && (event.tool === "Task" || event.tool === "Agent")) {
    try {
      const orig = typeof event.input.prompt === "string" ? event.input.prompt : "";
      if (orig.trim()) {
        const proto = (await import("node:fs")).readFileSync(new URL("../../../prompts/subagent-protocol.md", import.meta.url), "utf8").trim();
        const orchestrate = await inject(event); // parent-facing disjoint-coordination reminder (or null)
        await emit(modifyPreTool({ ...event.input, prompt: `${proto}\n${orig}` }, orchestrate ?? ""));
        return;
      }
    } catch { /* fall through to normal handling */ }
  }

  const content = await inject(event);

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

  // Skill layer, ON by default (turn off with "skills": false in ~/.cairn/config.json or CAIRN_SKILLS=0). The
  // agent retrieves skills ITSELF via the skill_search tool (taught in the base prompt) rather than via a
  // cosine auto-injection that mispicks near-duplicates. We enforce that with one per-turn reminder: record
  // when the agent calls skill_search, and remind ONCE if it reaches for an action tool first. The latch is
  // cleared at BOTH turn boundaries — the user_message that starts a normal turn AND the turn_finished that
  // ends any turn — so the next turn starts clean even when it is a resume after compaction, which fires no
  // user_message (that gap left a stale searched=true latch and silently suppressed the reminder all session).
  // On turn end, also fire background learning. Best-effort and isolated.
  const session = (payload as { session_id?: string }).session_id ?? "";
  if ((await import("../../core/config")).skillsEnabled()) {
    try {
      const { skillInject, skillLearn, skillsExist } = await import("../../skill/hook");
      const { resetSkillTurn, noteSkillSearched, claimSkillReminder, isActionTool, isSkillSearch, isSkillReview } = await import("../../skill/turngate");
      if (event.kind === "user_message") { resetSkillTurn(session); await skillInject(event.text, session); }
      else if (event.kind === "turn_finished") { resetSkillTurn(session); } // learning is agent-driven (skill_review), not auto at turn end
      else if (event.kind === "tool_completed" && isSkillReview(event.tool)) {
        // The agent declared a finished deliverable for a skill: learn over this turn's transcript, graded against that label.
        const label = typeof event.input.label === "string" ? event.input.label : "";
        skillLearn((payload as { transcript_path?: string }).transcript_path, label);
      }
      else if (event.kind === "tool_completed" && isSkillSearch(event.tool)) noteSkillSearched(session);
      else if (event.kind === "tool_pending" && isActionTool(event.tool) && skillsExist() && claimSkillReminder(session)) {
        out = out ? `${out}\n\n${SKILL_REMINDER}` : SKILL_REMINDER;
      }
    } catch { /* skills are best-effort */ }
  }

  if (!out) return;
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
