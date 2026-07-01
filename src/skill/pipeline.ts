import { categorize, reindexSkill } from "./match";
import { reviewAndLearn, type LearnResult } from "./reviewer";
import { addRun, addVersion, setMasterPrompt, skillLabels, topRuns, skillByLabel, normalizeLabel } from "./store";
import { recordActivity } from "./activity";
import type { SkillRun } from "./types";

// The skill loop, AGENT-DRIVEN. The main agent decides which skill its work belongs to — it reused one it
// found with skill_search, or minted a new one with skill_create — and declares it by calling skill_review
// with that label. So the reviewer never has to CLASSIFY a finished turn (the old unanchored segmenter is
// gone): its ONLY job is to grade the declared deliverable against that one skill and iterate its master.
// A turn that produced two deliverables (a story AND its review) is two skill_review calls, each landing here
// with its own label. The skill is auto-created if the label is new, so declaring a label always yields a run.

export interface RunInput { request: string; transcript: string; output: string }
export interface SkillResult { skillId: string; task: string; score: number; created: boolean }

export interface PipelineDeps {
  // Injected in tests. Grades `output` against the declared `label` (forced) and rewrites its master.
  learn?: (request: string, output: string, transcript: string, existing: string[], priors: SkillRun[], priorMaster: string, priorExplanation: string, label: string, what: string) => Promise<LearnResult>;
}

// Grade ONE agent-declared deliverable and store it under its skill (auto-created if the label is new). Returns
// the result, or null when the learner failed or produced nothing usable. The label is the AGENT's, forced into
// the learner, so the reviewer only iterates the master — it never re-labels the work.
export async function reviewDeclared(input: RunInput, label: string, what: string, now: number, deps: PipelineDeps = {}): Promise<SkillResult | null> {
  const norm = normalizeLabel(label);
  if (!norm) { recordActivity({ ts: now, phase: "skipped", request: input.request }); return null; } // no label ⇒ nothing to iterate
  const learn = deps.learn ?? ((req, out, tx, ex, pr, pm, pe, fl, fo) => reviewAndLearn(req, out, tx, ex, pr, pm, pe, undefined, fl, fo));

  recordActivity({ ts: now, phase: "start", request: input.request });
  const anchor = skillByLabel(norm);
  const priors = anchor ? topRuns(anchor.id, 10) : [];
  const result = await learn(input.request, input.output, input.transcript, skillLabels(), priors, anchor?.masterPrompt ?? "", anchor?.explanation ?? "", label, what);
  const { review, master, explanation } = result;
  if (result.failed || !review || !result.label) {
    recordActivity({ ts: now, phase: result.failed ? "failed" : "skipped", request: input.request, error: result.error });
    return null;
  }

  const { skill, created } = await categorize(label, now); // AUTO-CREATE the skill if the label is brand new
  const score = review.score;
  // Store the raw transcript as the run's process record + a CONCISE review (never review.raw: it holds the
  // whole master and the priors feed the next learner call, which ballooned every prompt).
  const conciseReview = JSON.stringify({ right: review.right, wrong: review.wrong, improve: review.improve });
  addRun({ skillId: skill.id, recipe: input.transcript, quality: score, review: conciseReview, ts: now });
  if (master) {
    setMasterPrompt(skill.id, master, explanation ?? "");
    addVersion(skill.id, master, explanation ?? "", score, now); // append to the master-version timeline (if it changed)
    await reindexSkill(skill.id, skill.task, master);
  }
  recordActivity({
    ts: now, phase: "learned", request: input.request, label: skill.task, score, created, master: Boolean(master),
    review: { right: review.right, wrong: review.wrong, improve: review.improve },
    output: input.output.slice(0, 400), // a short preview of what the agent delivered, for the feed
  });
  return { skillId: skill.id, task: skill.task, score, created };
}
