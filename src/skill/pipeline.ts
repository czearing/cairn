import { categorize, reindexSkill } from "./match";
import { reviewAndLearn, reviewAndLearnMany, classifyLabel, type LearnResult, type ClassifyResult } from "./reviewer";
import { addRun, setMasterPrompt, skillLabels, skillCatalog, topRuns, skillByLabel, normalizeLabel } from "./store";
import { recordActivity } from "./activity";
import { sessionSkill, type ReadyRun } from "./coordinate";
import { coordinatedReview } from "./coordinator";
import type { SkillRun } from "./types";

// End-to-end skill loop for one finished request, in TWO stages:
//  STAGE 1 (classify): decide the reusable label from the DELIVERABLE alone, with NO skill master or priors
//    as context. Anchoring the classifier to an embedding-matched skill made it mislabel a review of a story
//    as "short story" (proven 2026-06-29). Classifying unanchored fixes that at the root.
//  STAGE 2 (learn): grade the output and rewrite the master, now anchored to the skill the label ACTUALLY
//    resolves to, so the anchor always matches the decided label and can never flip it.
// Then the decided label picks/creates the skill (categorize, with the purpose guard) and the master is
// stored. A non-task yields an empty label and no skill. Each step is best-effort; the LLM steps are
// injectable for deterministic tests.

export interface RunInput { request: string; transcript: string; output: string }
export interface SkillResult { skillId: string; task: string; score: number; created: boolean }

export interface PipelineDeps {
  classify?: (request: string, output: string, transcript: string, existing: string[]) => Promise<ClassifyResult>;
  learn?: (request: string, output: string, transcript: string, existing: string[], priors: SkillRun[], priorMaster: string, priorExplanation: string, forcedLabel: string) => Promise<LearnResult>;
}

export async function processRun(input: RunInput, now: number, deps: PipelineDeps = {}): Promise<SkillResult[]> {
  const classify = deps.classify ?? ((req, out, tx, ex) => classifyLabel(req, out, tx, ex));
  const learn = deps.learn ?? ((req, out, tx, ex, pr, pm, pe, fl) => reviewAndLearn(req, out, tx, ex, pr, pm, pe, undefined, fl));

  recordActivity({ ts: now, phase: "start", request: input.request });
  const labels = skillLabels();

  // STAGE 1: classify the deliverable, unanchored. The classifier is shown the existing skills (with a gist
  // each) and reuses an existing label or coins a new one; that decision alone determines redundancy.
  const cls = await classify(input.request, input.output, input.transcript, skillCatalog());
  if (cls.failed) { recordActivity({ ts: now, phase: "failed", request: input.request, error: cls.error }); return []; }
  const label = cls.label;
  if (!label) { recordActivity({ ts: now, phase: "skipped", request: input.request }); return []; } // genuine non-task

  // STAGE 2: grade + rewrite, anchored to the skill THIS label resolves to (its current master + priors).
  const anchor = skillByLabel(normalizeLabel(label));
  const anchorPriors = anchor ? topRuns(anchor.id, 10) : [];
  const result = await learn(input.request, input.output, input.transcript, labels, anchorPriors, anchor?.masterPrompt ?? "", anchor?.explanation ?? "", label);
  const { review, master, explanation } = result;
  // The learner CLI call FAILED (record "failed" with the real reason) vs a clean run that still produced no
  // usable label (record "skipped"). Keeping them distinct stops a failed call from reading as "not a task".
  if (result.failed || !result.label) { recordActivity({ ts: now, phase: result.failed ? "failed" : "skipped", request: input.request, error: result.error }); return []; }

  // Write target = the EXACT skill for the decided label (reuse or create). No cosine: the classifier already
  // decided reuse-vs-new from the listed skills.
  const { skill, created } = await categorize(label, now);
  const score = review?.score ?? 0;
  // Store the raw transcript as the run's process record, and a CONCISE review (right/wrong/improve only).
  // Never store review.raw: it holds the full learner response incl. the whole master, and the priors are
  // fed back into the next learner call, so storing raw made every prompt balloon (~9KB per prior).
  const conciseReview = review ? JSON.stringify({ right: review.right, wrong: review.wrong, improve: review.improve }) : "";
  addRun({ skillId: skill.id, recipe: input.transcript, quality: score, review: conciseReview, ts: now });
  if (master) {
    setMasterPrompt(skill.id, master, explanation ?? "");
    await reindexSkill(skill.id, skill.task, master);
  }
  recordActivity({
    ts: now, phase: "learned", request: input.request, label: skill.task, score, created, master: Boolean(master),
    review: review ? { right: review.right, wrong: review.wrong, improve: review.improve } : undefined,
    output: input.output.slice(0, 400), // a short preview of what the agent delivered, for the feed
  });
  return [{ skillId: skill.id, task: skill.task, score, created }];
}

export interface CoordPipelineDeps {
  // Inject for tests: the coordination orchestrator, the unanchored classifier, and the multi-run reviewer.
  coordinate?: typeof coordinatedReview;
  classify?: (request: string, output: string, transcript: string, existing: string[]) => Promise<ClassifyResult>;
  reviewMany?: (request: string, runs: { output: string; transcript: string }[], existing: string[], priors: SkillRun[], priorMaster: string, priorExplanation: string, forcedLabel: string) => Promise<LearnResult>;
}

// Concurrency-aware entry point. If this session had a skill injected (it is refining a known skill), route
// through the coordinator: mark ready, wait for sibling windows, claim the per-skill lock, then ONE review
// covers every coalesced run and updates the master once. Only the session that wins the lock reviews; the
// others return without doing redundant work. A session with NO injected skill (a cold/new task) falls back
// to the solo processRun above. Best-effort and never throws.
export async function processRunCoordinated(input: RunInput, session: string, now: number, deps: CoordPipelineDeps = {}): Promise<SkillResult[]> {
  const skill = sessionSkill(session);
  if (!skill) return processRun(input, now);                       // cold/new task: no peers to coalesce with
  const classify = deps.classify ?? ((req, out, tx, ex) => classifyLabel(req, out, tx, ex));
  const reviewMany = deps.reviewMany ?? ((req, runs, ex, pr, pm, pe, fl) => reviewAndLearnMany(req, runs, ex, pr, pm, pe, undefined, fl));
  const coordinate = deps.coordinate ?? coordinatedReview;

  let out: SkillResult[] = [];
  await coordinate(session, skill, input.output, input.transcript, {
    review: async (runs: ReadyRun[]) => {
      recordActivity({ ts: now, phase: "start", request: input.request });
      const labels = skillLabels();
      // STAGE 1: classify unanchored from the representative deliverable, shown the existing skills. The injected
      // skill (what was matched at inject time) does NOT decide the label; a debugging turn that merely injected
      // "short story" must learn under "debugging" and never touch the story skill.
      const cls = await classify(input.request, input.output, input.transcript, skillCatalog());
      if (cls.failed) { recordActivity({ ts: now, phase: "failed", request: input.request, error: cls.error }); return; }
      const label = cls.label;
      if (!label) { recordActivity({ ts: now, phase: "skipped", request: input.request }); return; }

      // STAGE 2: anchor to the skill THIS label resolves to, then review all coalesced runs together.
      const anchor = skillByLabel(normalizeLabel(label));
      const priors = anchor ? topRuns(anchor.id, 10) : [];
      const result = await reviewMany(input.request, runs.map((r) => ({ output: r.output, transcript: r.transcript })), labels, priors, anchor?.masterPrompt ?? "", anchor?.explanation ?? "", label);
      const { review, master, explanation } = result;
      if (result.failed || !review || !result.label) {
        recordActivity({ ts: now, phase: result.failed ? "failed" : "skipped", request: input.request, error: result.error });
        return;
      }
      // Write target = the EXACT skill for the decided label (reuse or create). No cosine in the write path.
      const { skill: target, created } = await categorize(label, now);
      const conciseReview = JSON.stringify({ right: review.right, wrong: review.wrong, improve: review.improve });
      for (const r of runs) addRun({ skillId: target.id, recipe: r.transcript, quality: review.score, review: conciseReview, ts: now });
      if (master) {
        setMasterPrompt(target.id, master, explanation ?? "");
        await reindexSkill(target.id, target.task, master);
      }
      recordActivity({
        ts: now, phase: "learned", request: input.request, label: target.task, score: review.score, created, master: Boolean(master),
        review: { right: review.right, wrong: review.wrong, improve: review.improve },
        output: `${runs.length} concurrent run(s) merged: ` + input.output.slice(0, 400),
      });
      out = [{ skillId: target.id, task: target.task, score: review.score, created }];
    },
  });
  return out;
}
