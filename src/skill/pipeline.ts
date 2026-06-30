import { categorize, reindexSkill } from "./match";
import { reviewAndLearn, reviewAndLearnMany, segmentRun, type LearnResult, type SegmentResult, type Deliverable } from "./reviewer";
import { addRun, addVersion, setMasterPrompt, skillLabels, skillCatalog, topRuns, skillByLabel, normalizeLabel } from "./store";
import { recordActivity } from "./activity";
import { sessionSkill, type ReadyRun } from "./coordinate";
import { coordinatedReview } from "./coordinator";
import type { SkillRun } from "./types";

// End-to-end skill loop for one finished request, in TWO stages:
//  STAGE 1 (segment): the reviewing agent reads the DELIVERABLE(s) — unanchored, with NO skill master or
//    priors — and lists each distinct deliverable the turn produced with its label. A turn that writes a
//    story AND reviews it yields TWO deliverables (the model does the splitting, no transcript-slicing code).
//    Anchoring the labeler to a skill made it mislabel a review of a story as "short story" (proven
//    2026-06-29), so segmentation stays unanchored.
//  STAGE 2 (learn): grade EACH deliverable and rewrite its skill's master, anchored to the skill its label
//    resolves to, with `focus` naming which deliverable to grade so a story and its review never blur.
// A non-task yields no deliverables and no skill. Each step is best-effort; the LLM steps are injectable.

export interface RunInput { request: string; transcript: string; output: string }
export interface SkillResult { skillId: string; task: string; score: number; created: boolean }

export interface PipelineDeps {
  segment?: (request: string, output: string, transcript: string, existing: string[]) => Promise<SegmentResult>;
  learn?: (request: string, output: string, transcript: string, existing: string[], priors: SkillRun[], priorMaster: string, priorExplanation: string, forcedLabel: string, focus: string) => Promise<LearnResult>;
}

type LearnFn = NonNullable<PipelineDeps["learn"]>;

// Grade ONE segmented deliverable (named by `focus`) and store it under its own skill. Returns the result,
// or null when the learner failed or produced nothing usable. Anchored to the skill the label resolves to,
// so a story and a review of that story land in their OWN skills with their OWN masters.
async function gradeAndStore(input: RunInput, d: Deliverable, labels: string[], now: number, learn: LearnFn): Promise<SkillResult | null> {
  const anchor = skillByLabel(normalizeLabel(d.label));
  const anchorPriors = anchor ? topRuns(anchor.id, 10) : [];
  const result = await learn(input.request, input.output, input.transcript, labels, anchorPriors, anchor?.masterPrompt ?? "", anchor?.explanation ?? "", d.label, d.what);
  const { review, master, explanation } = result;
  if (result.failed || !result.label) { recordActivity({ ts: now, phase: result.failed ? "failed" : "skipped", request: input.request, error: result.error }); return null; }
  const { skill, created } = await categorize(d.label, now);
  const score = review?.score ?? 0;
  // Store the raw transcript as the run's process record + a CONCISE review (never review.raw: it holds the
  // whole master and the priors feed the next learner call, which ballooned every prompt).
  const conciseReview = review ? JSON.stringify({ right: review.right, wrong: review.wrong, improve: review.improve }) : "";
  addRun({ skillId: skill.id, recipe: input.transcript, quality: score, review: conciseReview, ts: now });
  if (master) {
    setMasterPrompt(skill.id, master, explanation ?? "");
    addVersion(skill.id, master, explanation ?? "", score, now); // append to the master-version timeline (if it changed)
    await reindexSkill(skill.id, skill.task, master);
  }
  recordActivity({
    ts: now, phase: "learned", request: input.request, label: skill.task, score, created, master: Boolean(master),
    review: review ? { right: review.right, wrong: review.wrong, improve: review.improve } : undefined,
    output: input.output.slice(0, 400), // a short preview of what the agent delivered, for the feed
  });
  return { skillId: skill.id, task: skill.task, score, created };
}

export async function processRun(input: RunInput, now: number, deps: PipelineDeps = {}): Promise<SkillResult[]> {
  const segment = deps.segment ?? ((req, out, tx, ex) => segmentRun(req, out, tx, ex));
  const learn: LearnFn = deps.learn ?? ((req, out, tx, ex, pr, pm, pe, fl, fo) => reviewAndLearn(req, out, tx, ex, pr, pm, pe, undefined, fl, fo));

  recordActivity({ ts: now, phase: "start", request: input.request });
  const labels = skillLabels();

  // STAGE 1: the reviewing agent lists EVERY distinct deliverable the turn produced, unanchored (no master),
  // so a story-writing turn that also reviews the story yields both "short story" and "short story review".
  const seg = await segment(input.request, input.output, input.transcript, skillCatalog());
  if (seg.failed) { recordActivity({ ts: now, phase: "failed", request: input.request, error: seg.error }); return []; }
  if (!seg.deliverables.length) { recordActivity({ ts: now, phase: "skipped", request: input.request }); return []; } // non-task

  // STAGE 2: grade + store EACH deliverable under its own skill, anchored to that skill's master + priors.
  const results: SkillResult[] = [];
  for (const d of seg.deliverables) { const r = await gradeAndStore(input, d, labels, now, learn); if (r) results.push(r); }
  return results;
}

export interface CoordPipelineDeps {
  // Inject for tests: the coordination orchestrator, the unanchored segmenter, and the multi-run reviewer.
  coordinate?: typeof coordinatedReview;
  segment?: (request: string, output: string, transcript: string, existing: string[]) => Promise<SegmentResult>;
  reviewMany?: (request: string, runs: { output: string; transcript: string }[], existing: string[], priors: SkillRun[], priorMaster: string, priorExplanation: string, forcedLabel: string, focus: string) => Promise<LearnResult>;
}

// Concurrency-aware entry point. If this session had a skill injected (it is refining a known skill), route
// through the coordinator: mark ready, wait for sibling windows, claim the per-skill lock, then ONE review
// covers every coalesced run and updates the master once. Only the session that wins the lock reviews; the
// others return without doing redundant work. A session with NO injected skill (a cold/new task) falls back
// to the solo processRun above. Best-effort and never throws.
export async function processRunCoordinated(input: RunInput, session: string, now: number, deps: CoordPipelineDeps = {}): Promise<SkillResult[]> {
  const skill = sessionSkill(session);
  if (!skill) return processRun(input, now);                       // cold/new task: no peers to coalesce with
  const segment = deps.segment ?? ((req, out, tx, ex) => segmentRun(req, out, tx, ex));
  const reviewMany = deps.reviewMany ?? ((req, runs, ex, pr, pm, pe, fl, fo) => reviewAndLearnMany(req, runs, ex, pr, pm, pe, undefined, fl, fo));
  const coordinate = deps.coordinate ?? coordinatedReview;

  const out: SkillResult[] = [];
  await coordinate(session, skill, input.output, input.transcript, {
    review: async (runs: ReadyRun[]) => {
      recordActivity({ ts: now, phase: "start", request: input.request });
      const labels = skillLabels();
      // STAGE 1: segment the representative run, unanchored. The injected skill does NOT decide the labels.
      const seg = await segment(input.request, input.output, input.transcript, skillCatalog());
      if (seg.failed) { recordActivity({ ts: now, phase: "failed", request: input.request, error: seg.error }); return; }
      if (!seg.deliverables.length) { recordActivity({ ts: now, phase: "skipped", request: input.request }); return; }

      // STAGE 2: grade + store EACH deliverable. The deliverable that IS the coalesced session skill grades all
      // concurrent attempts together (the coordinator's win); any extra deliverable (e.g. the review the writer
      // spawned) grades just this representative run.
      const sessionNorm = normalizeLabel(skill);
      for (const d of seg.deliverables) {
        const anchor = skillByLabel(normalizeLabel(d.label));
        const priors = anchor ? topRuns(anchor.id, 10) : [];
        const isSession = normalizeLabel(d.label) === sessionNorm;
        const attempts = isSession ? runs.map((r) => ({ output: r.output, transcript: r.transcript })) : [{ output: input.output, transcript: input.transcript }];
        const result = await reviewMany(input.request, attempts, labels, priors, anchor?.masterPrompt ?? "", anchor?.explanation ?? "", d.label, d.what);
        const { review, master, explanation } = result;
        if (result.failed || !review || !result.label) { recordActivity({ ts: now, phase: result.failed ? "failed" : "skipped", request: input.request, error: result.error }); continue; }
        const { skill: target, created } = await categorize(d.label, now);
        const conciseReview = JSON.stringify({ right: review.right, wrong: review.wrong, improve: review.improve });
        const recipes = isSession ? runs.map((r) => r.transcript) : [input.transcript];
        for (const recipe of recipes) addRun({ skillId: target.id, recipe, quality: review.score, review: conciseReview, ts: now });
        if (master) {
          setMasterPrompt(target.id, master, explanation ?? "");
          addVersion(target.id, master, explanation ?? "", review.score, now); // append to the master-version timeline (if it changed)
          await reindexSkill(target.id, target.task, master);
        }
        recordActivity({
          ts: now, phase: "learned", request: input.request, label: target.task, score: review.score, created, master: Boolean(master),
          review: { right: review.right, wrong: review.wrong, improve: review.improve },
          output: (isSession && runs.length > 1 ? `${runs.length} concurrent run(s) merged: ` : "") + input.output.slice(0, 400),
        });
        out.push({ skillId: target.id, task: target.task, score: review.score, created });
      }
    },
  });
  return out;
}
