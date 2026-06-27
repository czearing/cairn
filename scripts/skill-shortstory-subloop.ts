// Two compounding skill loops that BOTH PERSIST runs to the store: a WRITER and a separate, self-improving
// REVIEWER. Each round the writer drafts (its master), a reviewer critiques the draft (its OWN master), the
// writer revises against the critique, then BOTH skills are graded, rewritten, and a run is recorded:
//   - writer: through the real processRun path (so it also shows in the /activity feed), under skill "short story"
//   - reviewer: managed by EXACT label "short story review" (skillByLabel + insertSkillIfAbsent) so the fuzzy
//     categorize() match cannot collapse it into the writer skill; graded with reviewAndLearn, run added via addRun.
// Purely ADDITIVE: it seeds/updates master fields and appends runs (addRun keeps top-10 per skill). It never
// runs DELETE FROM skills/skill_runs, so existing history is preserved.
// Run: bun scripts/skill-shortstory-subloop.ts [maxRounds]
import { randomUUID } from "node:crypto";
import { runClaude } from "../src/skill/claude";
import { cairnMcpConfigPath } from "../src/skill/cairn-mcp";
import { processRun } from "../src/skill/pipeline";
import { reviewAndLearn } from "../src/skill/reviewer";
import { reindexSkill } from "../src/skill/match";
import { normalizeLabel, skillByLabel, insertSkillIfAbsent, setMasterPrompt, addRun, topRuns, skillLabels } from "../src/skill/store";
import { embed } from "../src/core/embed";
import { BASELINE_MASTER } from "./shortstory-baseline";
import type { Skill, Review } from "../src/skill/types";

const WRITER = "write a short story";       // request the writer skill is keyed on (normalizes to "short story")
const REVIEWER = "short story review";       // explicit distinct label for the reviewer skill
const TARGET = 0.9;
const MAX_ROUNDS = Number(process.argv[2] || 6);
const tools = { allowedTools: ["WebSearch", "mcp__cairn__brain_search"], mcpConfigPath: cairnMcpConfigPath(), timeoutMs: 300_000 };
const concise = (r: Review | null) => (r ? JSON.stringify({ right: r.right, wrong: r.wrong, improve: r.improve }) : "");

// Find a skill by EXACT normalized label, creating it (idempotently) if absent. Bypasses the fuzzy matcher
// so the reviewer never collapses into the writer skill. Additive: never deletes.
async function ensureSkill(label: string, seedMaster = ""): Promise<Skill> {
  const norm = normalizeLabel(label);
  let s = skillByLabel(norm);
  if (!s) {
    let vec: number[] = [];
    try { vec = await embed(label); } catch { /* embedder down: exact-label key still works */ }
    insertSkillIfAbsent({ id: randomUUID(), task: label, masterPrompt: seedMaster, ts: Date.now() }, vec);
    s = skillByLabel(norm)!;
    if (seedMaster) await reindexSkill(s.id, label, seedMaster);
  }
  return s;
}

async function gen(prompt: string, divider: string): Promise<{ ok: boolean; body: string; error?: string }> {
  const extract = (r: { ok: boolean; text: string; error?: string }) => {
    const full = r.text.trim();
    const i = full.lastIndexOf(divider);
    return (i >= 0 ? full.slice(i + divider.length) : full).trim();
  };
  let r = await runClaude(prompt, tools);
  let body = extract(r);
  if (!r.ok || !body) { r = await runClaude(prompt, tools); body = extract(r); }
  return { ok: r.ok && !!body, body, error: r.error };
}

const writerDraftPrompt = (master: string) =>
  `Approach learned from prior runs (follow it fully, including research preamble and self-review):\n${master}\n\nWork the full process out loud, then end your message with a line containing only ===STORY=== followed by the FINAL short story of exactly two paragraphs.`;
const reviewerPrompt = (rmaster: string, draft: string) =>
  `${rmaster ? `Approach learned for reviewing short stories (follow it):\n${rmaster}\n\n` : ""}You are a ruthless literary-fiction editor. Review this two-paragraph short-story draft. Find concrete weaknesses: first-association cliche, a stated or explained theme, a self-gloss or a closing line that names the irony, a factually false or opaque central mechanism, a static portrait with no real choice or cost, airless uniform-density prose, AI tells. For each, quote the offending text and give one specific actionable fix. Be surgical, not generic. End your message with a line containing only ===REVIEW=== followed by your critique.\n\nDRAFT:\n${draft}`;
const revisePrompt = (master: string, draft: string, critique: string) =>
  `Approach:\n${master}\n\nYour draft:\n${draft}\n\nAn editor flagged these issues:\n${critique}\n\nRevise into the FINAL short story of exactly two paragraphs. Fix every valid flag and delete any line that explains its own meaning. End your message with a line containing only ===STORY=== followed by the final story.`;

// Seed the writer skill master from the baseline (additive: updates the master field, keeps all runs), and
// ensure the reviewer skill exists. Neither deletes anything.
const writerSkill = await ensureSkill(WRITER);
setMasterPrompt(writerSkill.id, BASELINE_MASTER);
await reindexSkill(writerSkill.id, WRITER, BASELINE_MASTER);
await ensureSkill(REVIEWER);
console.log(`two-loop run (PERSISTING runs): writer seeded from baseline, reviewer "${REVIEWER}". chasing ${TARGET}, max ${MAX_ROUNDS} rounds\n`);

const writerScores: number[] = [];
const reviewScores: number[] = [];
const fails: number[] = [];

for (let round = 1; round <= MAX_ROUNDS; round++) {
  const now = Date.now();
  const w = skillByLabel(normalizeLabel(WRITER))!;
  const r = skillByLabel(normalizeLabel(REVIEWER))!;
  const writerMaster = w.masterPrompt || BASELINE_MASTER;
  const reviewMaster = r.masterPrompt || "";

  // 1. Writer drafts.
  const draft = await gen(writerDraftPrompt(writerMaster), "===STORY===");
  if (!draft.ok) { fails.push(round); console.log(`==================== round ${round}  DRAFT FAILED (${draft.error || "empty"}); skipped ====================\n`); continue; }

  // 2. Reviewer critiques with its own master.
  const review = await gen(reviewerPrompt(reviewMaster, draft.body), "===REVIEW===");
  const critique = review.ok ? review.body : "";

  // 3. Writer revises against the critique.
  const revised = critique ? await gen(revisePrompt(writerMaster, draft.body, critique), "===STORY===") : { ok: false, body: "", error: "no critique" };
  const final = revised.ok ? revised.body : draft.body;

  // 4. Grade + PERSIST the writer via the real pipeline (records run, rewrites master, logs to /activity).
  const wTranscript = `[draft]\n${draft.body}\n\n[review]\n${critique}\n\n[final]\n${final}`;
  const wres = await processRun({ request: WRITER, transcript: wTranscript, output: final }, now);
  const wScore = wres[0]?.score ?? 0;
  writerScores.push(wScore);

  // 5. Grade + PERSIST the reviewer under its EXPLICIT skill (no fuzzy categorize, no collision).
  let rScore = -1;
  if (critique) {
    const rTranscript = `[story draft]\n${draft.body}\n\n[critique produced]\n${critique}\n\n[final story after applying it]\n${final}`;
    const rl = await reviewAndLearn("critique a two-paragraph short story draft and propose specific fixes that raise its quality", critique, rTranscript, skillLabels(), topRuns(r.id, 10));
    rScore = rl.review?.score ?? 0;
    addRun({ skillId: r.id, recipe: rTranscript, quality: rScore, review: concise(rl.review), ts: now });
    reviewScores.push(rScore);
    if (rl.master) { setMasterPrompt(r.id, rl.master); await reindexSkill(r.id, REVIEWER, rl.master); }
  }

  console.log(`==================== round ${round}  writer ${wScore.toFixed(2)}  reviewer ${rScore < 0 ? "n/a" : rScore.toFixed(2)}  ${revised.ok ? "(revised)" : "(no revision)"} ====================\n${final}\n`);
  if (wScore >= TARGET) { console.log(`>>> writer reached ${TARGET} at round ${round}`); break; }
}

console.log("writer scores:   " + (writerScores.map((s) => s.toFixed(2)).join(" -> ") || "(none)"));
console.log("reviewer scores: " + (reviewScores.map((s) => s.toFixed(2)).join(" -> ") || "(none)"));
if (fails.length) console.log(`failed (draft) rounds, not graded: ${fails.join(", ")}`);
console.log(`writer best ${writerScores.length ? Math.max(...writerScores).toFixed(2) : "n/a"} (single-loop baseline was 0.81)`);
const wf = skillByLabel(normalizeLabel(WRITER))!, rf = skillByLabel(normalizeLabel(REVIEWER))!;
console.log(`\nPERSISTED: writer skill "${wf.task}" has ${topRuns(wf.id, 100).length} runs; reviewer skill "${rf.task}" has ${topRuns(rf.id, 100).length} runs.`);
