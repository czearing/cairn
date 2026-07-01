import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { runLearner } from "./runner";
import { cairnMcpConfigPath } from "./cairn-mcp";
import { LEARN_SYSTEM, learnUserPrompt } from "./prompts";
import type { Review, SkillRun } from "./types";

// The learner: ONE cairn-connected Claude that, in a single call, ASSIGNS the task's reusable label,
// GRADES the new output, and REWRITES the skill's master prompt. This folds the old standalone labeler
// into the learner (the loop went from 3 spawned agents to 2). Because the label is an OUTPUT of this
// call, the skill is not known beforehand, so the learner is stateless: the prior runs it needs are
// passed in the prompt (picked by an embedding pre-match), not via a resumed per-skill session.

/** The learner's three outputs: the assigned label (null for a non-task), the graded verdict, and the
 *  rewritten master prompt (each may be null if the model omitted it). `failed` is true ONLY when the CLI
 *  call itself failed (spawn error / non-zero exit / empty output), which is distinct from a genuine
 *  non-task where the learner ran fine and chose an empty label. */
export interface LearnResult { label: string | null; review: Review | null; master: string | null; explanation: string | null; failed?: boolean; error?: string }

/** Pure: build a LearnResult from the learner's structured skill_output JSON (its tool submission). Returns
 *  null when there is no submission to read. The label is the LOOP's, not the learner's: pass the decided
 *  `forcedLabel` and it wins outright (the learner no longer echoes a label, so an omitted or stray one can
 *  neither drop nor corrupt the review). A labeled submission missing a valid score or a master is a hard
 *  failure (failed:true with the reason), never silently accepted as a partial result. */
export function fromCapture(raw: string | null | undefined, forcedLabel?: string): LearnResult | null {
  if (!raw) return null;
  let o: { label?: unknown; score?: unknown; right?: unknown; wrong?: unknown; improve?: unknown; master?: unknown; explanation?: unknown };
  try { o = JSON.parse(raw); } catch { return { label: null, review: null, master: null, explanation: null, failed: true, error: "skill_output capture was not valid JSON" }; }
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  const score = typeof o.score === "number" ? o.score : Number(o.score);
  const scoreOk = Number.isFinite(score) && score >= 0 && score <= 1;
  const label = (forcedLabel ?? "").trim() || (str(o.label).trim() || null);
  const master = str(o.master).trim() || null;
  const explanation = str(o.explanation).trim() || null;
  if (label && (!scoreOk || !master || !explanation)) return { label: null, review: null, master: null, explanation: null, failed: true, error: "skill_output for a labeled task was incomplete (needs a 0..1 score, a master, and an explanation)" };
  // A non-task (no label) grades nothing, so it carries no review; a labeled task always has a valid score here.
  const review: Review | null = label ? { score, right: str(o.right), wrong: str(o.wrong), improve: str(o.improve), raw: raw.trim() } : null;
  return { label, review, master, explanation };
}

/** In one cairn-connected call, the learner reasons out loud to assign the label for `request`, grade
 *  `output` (with the raw run `transcript` as process context), and rewrite the master, then submits the
 *  result via the skill_output tool. We read that structured submission (captured to a temp file via
 *  CAIRN_SKILL_OUTPUT_PATH); if it never submits a valid one, we fail loudly with the real reason.
 *  Returns {label, review, master}; never throws. */
export async function reviewAndLearn(request: string, output: string, transcript: string, existing: string[], priors: SkillRun[], priorMaster = "", priorExplanation = "", timeoutMs?: number, forcedLabel?: string, focus = ""): Promise<LearnResult> {
  // Labeling is the loop's job, never the learner's: the label was decided in STAGE 1 and is handed to the
  // skill_output tool via the CAIRN_SKILL_FORCED_LABEL env below. The learner only grades and rewrites the
  // master, so it never sees, echoes, or can corrupt a label. `focus` names which of the turn's deliverables
  // to grade when the turn produced more than one (e.g. the review, not the story it reviews).
  const user = learnUserPrompt(request, output, transcript, existing, priors, priorMaster, priorExplanation, focus);
  const outPath = join(tmpdir(), `cairn-learn-${randomUUID()}.json`);
  const r = await runLearner(user, {
    system: LEARN_SYSTEM,
    mcpConfigPath: cairnMcpConfigPath(),
    allowedTools: ["mcp__cairn__brain_search", "mcp__cairn__skill_output"],
    env: { CAIRN_SKILL_OUTPUT_PATH: outPath, CAIRN_SKILL_FORCED_LABEL: forcedLabel ?? "" },
    timeoutMs: timeoutMs ?? 180_000, // background, thorough call: give it room (the 90s default timed out)
    // Model: use the CLI default by default. Measured A/B (2026-06-26): forcing sonnet-4.6 was SLOWER than the
    // default (117s vs 87s) and haiku-4.5 both slower AND failed to emit a valid skill_output, so the model
    // tier is not the bottleneck. The hook is kept only as an opt-in escape (CAIRN_LEARN_MODEL).
    model: process.env.CAIRN_LEARN_MODEL || undefined,
  });
  let captured: LearnResult | null = null;
  try { if (existsSync(outPath)) captured = fromCapture(readFileSync(outPath, "utf8"), forcedLabel); } catch { /* handled below */ }
  try { if (existsSync(outPath)) rmSync(outPath); } catch { /* ignore */ }
  if (captured) return captured;                                // the learner submitted a valid review via the tool
  // No valid submission. Fail LOUDLY with the real reason (no silent retry, no "transient" assumption): either
  // the claude call errored, or it finished without ever calling skill_output with complete data.
  const reason = r.ok ? "the learner finished without submitting a valid skill_output" : (r.error || "claude call failed");
  return { label: null, review: null, master: null, explanation: null, failed: true, error: reason };
}
