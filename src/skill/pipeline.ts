import { reindexSkill } from "./match";
import { reviewAndLearn, type LearnResult } from "./reviewer";
import { addRun, addVersion, setMasterPrompt, skillLabels, topRuns, getSkill } from "./store";
import { recordActivity } from "./activity";
import type { SkillRun } from "./types";

// The skill loop, AGENT-DRIVEN. The main agent decides which skill its work belongs to — it reused one it
// found with skill_search, or minted a new one with skill_create — and declares it by calling skill_review
// with that skill's ID. Referencing the concrete id (not a re-typed label) means there is no fuzzy match to
// drift or spawn a near-duplicate: the run lands on exactly the skill the agent picked. The reviewer never
// CLASSIFIES a finished turn (the old unanchored segmenter is gone): its ONLY job is to grade the declared
// deliverable against that one skill and iterate its master. A turn with two deliverables (a story AND its
// review) is two skill_review calls, each with its own skill id.

export interface RunInput { request: string; transcript: string; output: string }
export interface SkillResult { skillId: string; task: string; score: number }

export interface PipelineDeps {
  // Injected in tests. Grades `output` against the declared skill's label (forced) and rewrites its master.
  learn?: (request: string, output: string, transcript: string, existing: string[], priors: SkillRun[], priorMaster: string, priorExplanation: string, label: string) => Promise<LearnResult>;
}

// Grade ONE agent-declared deliverable and store it under the skill it referenced BY ID. Returns the result,
// or null when the id is unknown/blank or the learner failed. The skill must already exist (skill_search found
// it or skill_create minted it), so nothing is auto-created here — an unknown id simply no-ops. The skill's own
// label is forced into the learner, so the reviewer only iterates the master; it never re-labels the work.
export async function reviewDeclared(input: RunInput, skillId: string, now: number, deps: PipelineDeps = {}): Promise<SkillResult | null> {
  const skill = skillId.trim() ? getSkill(skillId.trim()) : null;
  if (!skill) { recordActivity({ ts: now, phase: "skipped", request: input.request }); return null; } // unknown/blank id ⇒ nothing to iterate
  const learn = deps.learn ?? ((req, out, tx, ex, pr, pm, pe, fl) => reviewAndLearn(req, out, tx, ex, pr, pm, pe, undefined, fl));

  recordActivity({ ts: now, phase: "start", request: input.request });
  const priors = topRuns(skill.id, 10);
  const result = await learn(input.request, input.output, input.transcript, skillLabels(), priors, skill.masterPrompt ?? "", skill.explanation ?? "", skill.task);
  const { review, master, explanation } = result;
  if (result.failed || !review || !result.label) {
    recordActivity({ ts: now, phase: result.failed ? "failed" : "skipped", request: input.request, error: result.error });
    return null;
  }

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
    ts: now, phase: "learned", request: input.request, label: skill.task, score, created: priors.length === 0, master: Boolean(master),
    review: { right: review.right, wrong: review.wrong, improve: review.improve },
    output: input.output.slice(0, 400), // a short preview of what the agent delivered, for the feed
  });
  return { skillId: skill.id, task: skill.task, score };
}
