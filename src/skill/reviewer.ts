import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { runLearner } from "./runner";
import { cairnMcpConfigPath } from "./cairn-mcp";
import { LEARN_SYSTEM, learnUserPrompt, CLASSIFY_SYSTEM, classifyUserPrompt } from "./prompts";
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

// Pure: extract and validate a JSON verdict from text. Returns null on junk or an out-of-range score.
export function parseReview(raw: string | null | undefined): Review | null {
  if (!raw) return null;
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return null;
  let o: { score?: unknown; right?: unknown; wrong?: unknown; improve?: unknown };
  try { o = JSON.parse(m[0]); } catch { return null; }
  const score = typeof o.score === "number" ? o.score : Number(o.score);
  if (!Number.isFinite(score) || score < 0 || score > 1) return null;
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  return { score, right: str(o.right), wrong: str(o.wrong), improve: str(o.improve), raw: raw.trim() };
}

// Pure: split the single response into the verdict JSON (before ===MASTER===) and the rewritten master
// (after). The label is read from the same JSON object as the verdict. The delimiter avoids embedding a
// long, newline-heavy master inside JSON, which models escape unreliably.
export function parseLearn(raw: string | null | undefined): LearnResult {
  if (!raw) return { label: null, review: null, master: null, explanation: null };
  const sep = "===MASTER===";
  const i = raw.indexOf(sep);
  const head = i >= 0 ? raw.slice(0, i) : raw;
  const master = (i >= 0 ? raw.slice(i + sep.length).trim() : "") || null;
  let label: string | null = null;
  const m = head.match(/\{[\s\S]*\}/);
  if (m) {
    try { const o = JSON.parse(m[0]) as { label?: unknown }; if (typeof o.label === "string" && o.label.trim()) label = o.label.trim(); } catch { /* no label */ }
  }
  return { label, review: parseReview(head), master, explanation: null }; // legacy text path carries no explanation
}

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

// Pure: read the deliverables JSON array printed after the final ===DELIVERABLES=== delimiter. Each is a
// {label, what}; dedup by label so one turn never makes two runs of the same skill. Empty/garbage -> [].
export interface Deliverable { label: string; what: string }
export function parseDeliverables(raw: string | null | undefined): Deliverable[] {
  if (!raw) return [];
  const sep = "===DELIVERABLES===";
  const i = raw.lastIndexOf(sep);
  const tail = (i >= 0 ? raw.slice(i + sep.length) : raw).trim();
  const m = tail.match(/\[[\s\S]*\]/);
  if (!m) return [];
  let arr: unknown;
  try { arr = JSON.parse(m[0]); } catch { return []; }
  if (!Array.isArray(arr)) return [];
  const out: Deliverable[] = [];
  const seen = new Set<string>();
  for (const it of arr) {
    const o = (it ?? {}) as { label?: unknown; what?: unknown };
    const label = typeof o.label === "string" ? o.label.trim().slice(0, 60).toLowerCase() : "";
    if (!label || seen.has(label)) continue;
    seen.add(label);
    out.push({ label, what: typeof o.what === "string" ? o.what.trim().slice(0, 200) : "" });
  }
  return out;
}

/** STAGE 1 of the loop: the reviewing agent reads the finished turn and lists EACH distinct deliverable it
 *  produced with its reusable label — UNANCHORED (no skill master/priors), so it can never be biased into
 *  mislabeling a review of a story as "short story" (the anchoring failure proven 2026-06-29). A turn that
 *  writes a story AND reviews it yields two deliverables; most yield one; a non-task yields none. No tools. */
export interface SegmentResult { deliverables: Deliverable[]; failed: boolean; error?: string }
export async function segmentRun(request: string, output: string, transcript: string, existing: string[], timeoutMs?: number): Promise<SegmentResult> {
  const r = await runLearner(classifyUserPrompt(request, output, transcript, existing), {
    system: CLASSIFY_SYSTEM,
    timeoutMs: timeoutMs ?? 90_000,
    model: process.env.CAIRN_CLASSIFY_MODEL || process.env.CAIRN_LEARN_MODEL || undefined,
  });
  if (!r.ok) return { deliverables: [], failed: true, error: r.error || "segment call failed" };
  return { deliverables: parseDeliverables(r.text), failed: false };
}

/** In one cairn-connected call, the learner reasons out loud to assign the label for `request`, grade
 *  `output` (with the raw run `transcript` as process context), and rewrite the master, then submits the
 *  result via the skill_output tool. We read that structured submission (captured to a temp file via
 *  CAIRN_SKILL_OUTPUT_PATH). Falls back to parsing the legacy ===MASTER=== text if the tool was not called.
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

/** Review SEVERAL concurrent attempts at the same task in ONE call and update the master from all of them (the
 *  coalesce path). One run delegates to reviewAndLearn; many are folded into one learner call whose output
 *  field carries every attempt, so the rewritten master reflects what the learner sees across the whole set. */
export async function reviewAndLearnMany(request: string, runs: { output: string; transcript: string }[], existing: string[], priors: SkillRun[], priorMaster = "", priorExplanation = "", timeoutMs?: number, forcedLabel?: string, focus = ""): Promise<LearnResult> {
  if (runs.length <= 1) {
    const r = runs[0];
    return reviewAndLearn(request, r?.output ?? "", r?.transcript ?? "", existing, priors, priorMaster, priorExplanation, timeoutMs, forcedLabel, focus);
  }
  const output = runs.map((r, i) => `=== Attempt ${i + 1} ===\n${r.output}`).join("\n\n");
  const transcript = runs.map((r, i) => `=== Attempt ${i + 1} ===\n${r.transcript}`).join("\n\n");
  const req = `${request}\n\n(These are ${runs.length} concurrent attempts at this same task from different sessions. Grade them together and update the master so it fixes what you see across all of them.)`;
  return reviewAndLearn(req, output, transcript, existing, priors, priorMaster, priorExplanation, timeoutMs, forcedLabel, focus);
}
