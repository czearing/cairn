import { labelTasks } from "./label";
import { categorize, reindexSkill } from "./match";
import { compactConversation } from "./compact";
import { reviewOutput, assembleMaster } from "./reviewer";
import { addRun, setMasterPrompt, skillLabels } from "./store";
import type { Review } from "./types";

// End-to-end skill loop for one finished request: label -> categorize -> compact the run -> review the
// output against prior runs -> store the run -> reassemble the master prompt from the best runs. A request
// can hold several skills, so labels are processed SERIALLY (there is one reviewer at a time). Each step is
// best-effort: a failed label/compact/review degrades (the run is still stored, ungraded) and never throws.
// The LLM steps are injectable so the wiring is tested deterministically.

export interface RunInput { request: string; transcript: string; output: string }
export interface SkillResult { skillId: string; task: string; score: number; created: boolean }

export interface PipelineDeps {
  label?: (request: string, existing: string[]) => Promise<string[]>;
  compact?: (transcript: string) => Promise<{ raw: string }>;
  review?: (skillId: string, task: string, output: string) => Promise<Review | null>;
  assemble?: (skillId: string, task: string) => Promise<string | null>;
}

export async function processRun(input: RunInput, now: number, deps: PipelineDeps = {}): Promise<SkillResult[]> {
  const label = deps.label ?? ((r, e) => labelTasks(r, e));
  const compact = deps.compact ?? ((t) => compactConversation(t));
  const review = deps.review ?? ((s, t, o) => reviewOutput(s, t, o));
  const assemble = deps.assemble ?? ((s, t) => assembleMaster(s, t));

  const labels = await label(input.request, skillLabels());
  const results: SkillResult[] = [];
  for (const task of labels) {
    const { skill, created } = await categorize(task, now);
    const { raw } = await compact(input.transcript);
    const verdict = await review(skill.id, task, input.output);
    const score = verdict?.score ?? 0;
    addRun({ skillId: skill.id, recipe: raw, quality: score, review: verdict ? JSON.stringify(verdict) : "", ts: now });
    const master = await assemble(skill.id, task);
    if (master) { setMasterPrompt(skill.id, master); await reindexSkill(skill.id, task, master); }
    results.push({ skillId: skill.id, task, score, created });
  }
  return results;
}
