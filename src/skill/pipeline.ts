import { categorize, reindexSkill, embedRequest, resolveForRun, freezeIdentityIfNew } from "./match";
import { reviewAndLearn, reviewAndLearnMany, type LearnResult } from "./reviewer";
import { retrieveSkill } from "./retrieve";
import { addRun, setMasterPrompt, skillLabels, topRuns } from "./store";
import { recordActivity } from "./activity";
import { sessionSkill, type ReadyRun } from "./coordinate";
import { coordinatedReview } from "./coordinator";
import type { Skill, SkillRun } from "./types";

// End-to-end skill loop for one finished request. The learner does labeling, grading, and master-rewrite
// in ONE call (the labeler was folded in), and grades with the raw run transcript as process context (the
// compaction step was removed: an A/B showed it cost an extra LLM call for no quality gain). So the loop
// is: embedding pre-match for context -> learn (sees the raw transcript) -> the learner's label picks/
// creates the skill (categorize) -> store -> set master. A non-task turn yields an empty label and no
// skill. Each step is best-effort and never throws; the LLM step is injectable for deterministic tests.

export interface RunInput { request: string; transcript: string; output: string }
export interface SkillResult { skillId: string; task: string; score: number; created: boolean }

export interface PipelineDeps {
  match?: (request: string) => Promise<Skill | null>;
  learn?: (request: string, output: string, transcript: string, existing: string[], priors: SkillRun[], priorMaster: string, priorExplanation: string) => Promise<LearnResult>;
}

export async function processRun(input: RunInput, now: number, deps: PipelineDeps = {}): Promise<SkillResult[]> {
  const match = deps.match ?? (async (req) => (await retrieveSkill(req))?.skill ?? null);
  const learn = deps.learn ?? ((req, out, tx, ex, pr, pm, pe) => reviewAndLearn(req, out, tx, ex, pr, pm, pe));

  // Cheap embedding pre-match to a candidate skill, only to give the learner that skill's prior runs as
  // context. The learner makes the accurate label decision; the pre-match just narrows which runs to show.
  recordActivity({ ts: now, phase: "start", request: input.request });
  const candidate = await match(input.request);
  const priors = candidate ? topRuns(candidate.id, 10) : [];
  // Hand the learner the skill's CURRENT master (instructions) and explanation (the prior reviewer's
  // rationale) so it refines them instead of rewriting blind.
  const result = await learn(input.request, input.output, input.transcript, skillLabels(), priors, candidate?.masterPrompt ?? "", candidate?.explanation ?? "");
  const { label, review, master, explanation } = result;
  // No label: either the learner CLI call FAILED (record "failed" with the real error reason) or the turn
  // is a genuine non-task (record "skipped"). Keeping them distinct stops a failed call from showing as
  // "not a reusable task" in the feed.
  if (!label) { recordActivity({ ts: now, phase: result.failed ? "failed" : "skipped", request: input.request, error: result.error }); return []; }

  // Resolve the skill this run writes to. With a master, run the purpose guard so a label that collided with
  // a different-purpose skill is routed to its own variant instead of clobbering the matched skill's master.
  let contentVec: number[] = [];
  let skill: Skill, created: boolean;
  if (master) {
    try { contentVec = await embedRequest(input.request); } catch { contentVec = []; }
    ({ skill, created } = contentVec.length ? await resolveForRun(label, contentVec, now) : await categorize(label, now));
  } else {
    ({ skill, created } = await categorize(label, now));
  }
  const score = review?.score ?? 0;
  // Store the raw transcript as the run's process record, and a CONCISE review (right/wrong/improve only).
  // Never store review.raw: it holds the full learner response incl. the whole master, and the priors are
  // fed back into the next learner call, so storing raw made every prompt balloon (~9KB per prior).
  const conciseReview = review ? JSON.stringify({ right: review.right, wrong: review.wrong, improve: review.improve }) : "";
  addRun({ skillId: skill.id, recipe: input.transcript, quality: score, review: conciseReview, ts: now });
  if (master) {
    setMasterPrompt(skill.id, master, explanation ?? "");
    freezeIdentityIfNew(skill.id, contentVec, input.request.slice(0, 400)); // freeze purpose (the request) on the first master write
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
  // Inject for tests: the coordination orchestrator, and the multi-run reviewer.
  coordinate?: typeof coordinatedReview;
  reviewMany?: (request: string, runs: { output: string; transcript: string }[], existing: string[], priors: SkillRun[], priorMaster: string, priorExplanation: string) => Promise<LearnResult>;
}

// Concurrency-aware entry point. If this session had a skill injected (it is refining a known skill), route
// through the coordinator: mark ready, wait for sibling windows, claim the per-skill lock, then ONE review
// covers every coalesced run and updates the master once. Only the session that wins the lock reviews; the
// others return without doing redundant work. A session with NO injected skill (a cold/new task) falls back
// to the solo processRun above. Best-effort and never throws.
export async function processRunCoordinated(input: RunInput, session: string, now: number, deps: CoordPipelineDeps = {}): Promise<SkillResult[]> {
  const skill = sessionSkill(session);
  if (!skill) return processRun(input, now);                       // cold/new task: no peers to coalesce with
  const reviewMany = deps.reviewMany ?? ((req, runs, ex, pr, pm, pe) => reviewAndLearnMany(req, runs, ex, pr, pm, pe));
  const coordinate = deps.coordinate ?? coordinatedReview;

  let out: SkillResult[] = [];
  await coordinate(session, skill, input.output, input.transcript, {
    review: async (runs: ReadyRun[]) => {
      recordActivity({ ts: now, phase: "start", request: input.request });
      const { skill: skillObj } = await categorize(skill, now);   // the skill already exists (it was injected)
      const priors = topRuns(skillObj.id, 10);
      const result = await reviewMany(input.request, runs.map((r) => ({ output: r.output, transcript: r.transcript })), skillLabels(), priors, skillObj.masterPrompt ?? "", skillObj.explanation ?? "");
      const { review, master, explanation } = result;
      if (result.failed || !review) {
        recordActivity({ ts: now, phase: result.failed ? "failed" : "skipped", request: input.request, error: result.error });
        return;
      }
      // Purpose-guard the write target too: a coalesced rewrite that drifted off the skill's frozen purpose
      // is routed to its own variant rather than clobbering the injected skill.
      let target = skillObj, contentVec: number[] = [];
      if (master) {
        try { contentVec = await embedRequest(input.request); } catch { contentVec = []; }
        if (contentVec.length) target = (await resolveForRun(skill, contentVec, now)).skill;
      }
      const conciseReview = JSON.stringify({ right: review.right, wrong: review.wrong, improve: review.improve });
      for (const r of runs) addRun({ skillId: target.id, recipe: r.transcript, quality: review.score, review: conciseReview, ts: now });
      if (master) {
        setMasterPrompt(target.id, master, explanation ?? "");
        freezeIdentityIfNew(target.id, contentVec, input.request.slice(0, 400));
        await reindexSkill(target.id, target.task, master);
      }
      recordActivity({
        ts: now, phase: "learned", request: input.request, label: target.task, score: review.score, created: false, master: Boolean(master),
        review: { right: review.right, wrong: review.wrong, improve: review.improve },
        output: `${runs.length} concurrent run(s) merged: ` + input.output.slice(0, 400),
      });
      out = [{ skillId: target.id, task: target.task, score: review.score, created: false }];
    },
  });
  return out;
}
