import { embed, cosine } from "../core/embed";
import { skillVectors, getSkill } from "./store";
import type { Skill } from "./types";

// Retrieval side of the loop: on a new turn, find the matching skill and inject its curated master prompt.
// This is the INSTANT path (one embed + a cosine scan, no LLM), separate from the accurate labeler used
// for assignment in the async learn phase. A slightly-off injection is low-harm (the agent can ignore it),
// so retrieval trades a little accuracy for speed. Calibrated (skill-retrieve-bench): real matches score
// >= 0.32 (6/6 correct), unrelated requests <= 0.27, so 0.30 separates them cleanly with no false inject.
export const RETRIEVE_THRESHOLD = Number(process.env.CAIRN_RETRIEVE_THRESHOLD || "0.30");
// Inject the SINGLE best-fitting skill, not a cluster. Injecting the top 2 stacked two near-duplicate
// masters (short story + short story review) behind a hedgy "draw on what fits" framing: a bloated wall the
// agent has to triage. One strict match the agent simply follows is cleaner and shorter. Raise
// CAIRN_RETRIEVE_K to pull a cluster again.
export const RETRIEVE_K = Number(process.env.CAIRN_RETRIEVE_K || "1");

const BARE_URL =
  /^(?:(?:https?|file):\/\/\S+|localhost(?::\d+)?(?:\/\S*)?|127\.0\.0\.1(?::\d+)?(?:\/\S*)?)$/i;

export function isBareUrlQuery(query: string): boolean {
  return BARE_URL.test(query.trim());
}

function handlesBareUrls(skill: Skill): boolean {
  return /\bbare url\b/i.test(skill.masterPrompt);
}

// Condense a turn's user messages into ONE query, so a 10-message turn does ONE search, not ten. The most
// recent messages carry the current ask; a little prior context disambiguates. Bounded so a long turn
// cannot blow up the embed input.
export function condenseMessages(messages: string[]): string {
  const cleaned = messages.map((m) => m.trim()).filter(Boolean);
  return cleaned.slice(-3).join(" ").slice(0, 2000);
}

// Instant semantic retrieval: embed the condensed query once, return the skills above threshold (top k by
// score). Empty on no match or an embedder failure (never crashes).
export async function retrieveSkills(query: string, k = RETRIEVE_K): Promise<{ skill: Skill; score: number }[]> {
  if (!query.trim()) return [];
  const vecs = skillVectors();
  if (!vecs.length) return []; // empty store: skip the embed entirely (the common default-on case early on)
  const bareUrl = isBareUrlQuery(query);
  let q: number[] = [];
  try { q = await embed(query); } catch { if (!bareUrl) return []; }
  const scored: { skill: Skill; score: number; urlHandler: boolean }[] = [];
  for (const s of vecs) {
    // max over the clean label vector and the rich (label+master) vector, so a query phrased with domain
    // vocabulary ("pull request description") still matches a skill labeled "pr description".
    let score = -1;
    if (s.vec.length === q.length) score = cosine(q, s.vec);
    if (s.rich.length === q.length) score = Math.max(score, cosine(q, s.rich));
    const skill = getSkill(s.id);
    if (!skill) continue;
    const urlHandler = bareUrl && handlesBareUrls(skill);
    if (score >= RETRIEVE_THRESHOLD || urlHandler) scored.push({ skill, score, urlHandler });
  }
  scored.sort((a, b) => Number(b.urlHandler) - Number(a.urlHandler) || b.score - a.score);
  return scored.slice(0, k).map(({ skill, score }) => ({ skill, score }));
}

// Rank EVERY skill by semantic similarity to a query (no threshold), most-relevant first. For the UI search
// box: the user types a query and sees all skills reordered by relevance, not a hard-filtered subset. Empty on
// an empty store or an embedder failure.
export async function rankSkillIds(query: string): Promise<{ id: string; score: number }[]> {
  if (!query.trim()) return [];
  const vecs = skillVectors();
  if (!vecs.length) return [];
  let q: number[];
  try { q = await embed(query); } catch { return []; }
  return vecs.map((s) => {
    let score = -1;
    if (s.vec.length === q.length) score = cosine(q, s.vec);
    if (s.rich.length === q.length) score = Math.max(score, cosine(q, s.rich));
    return { id: s.id, score };
  }).sort((a, b) => b.score - a.score);
}

// The single best match (or null), for callers that want just the top skill.
export async function retrieveSkill(query: string): Promise<{ skill: Skill; score: number } | null> {
  return (await retrieveSkills(query, 1))[0] ?? null;
}

export interface RetrieveDiag { storeCount: number; embedOk: boolean; embedDim: number; threshold: number; top: { task: string; score: number }[] }

// Explain a retrieval result, especially a 0-match: how many skills are in the store, whether the query
// embedded (an embedder failure is the silent path that turns into a bare "0"), the embedding dimension (a
// mismatch with the stored vectors zeroes every score), and the TOP raw scores even below threshold so a
// near-miss is visible. Used by the injection debug log so "matched 0" is never a mystery.
export async function retrieveDiagnostic(query: string): Promise<RetrieveDiag> {
  const vecs = skillVectors();
  let q: number[] = [], embedOk = false;
  if (query.trim()) { try { q = await embed(query); embedOk = true; } catch { embedOk = false; } }
  const top = vecs.map((s) => {
    let score = -1;
    if (q.length && s.vec.length === q.length) score = cosine(q, s.vec);
    if (q.length && s.rich.length === q.length) score = Math.max(score, cosine(q, s.rich));
    return { task: s.task, score };
  }).sort((a, b) => b.score - a.score).slice(0, 5);
  return { storeCount: vecs.length, embedOk, embedDim: q.length, threshold: RETRIEVE_THRESHOLD, top };
}

// The injected block has two parts, kept separate so a caller controls each on its own and can inject only
// the skill itself: the INSTRUCTIONS (the curated master prompt, the given skill) and the EXPLANATION (the
// framing that says what the block is and where it came from). injectionText composes whatever it is handed.

// Just the skill instructions, no framing: one master prompt, or several stacked under task headers. This is
// the "given skill" content and the only thing that must be injected.
export function skillInstructions(skills: Skill[]): string {
  const withMaster = skills.filter((s) => s.masterPrompt.trim());
  if (!withMaster.length) return "";
  if (withMaster.length === 1) return withMaster[0]!.masterPrompt;
  return withMaster.map((s) => `## ${s.task}\n${s.masterPrompt}`).join("\n\n");
}

// The framing that explains what the instructions are. Separate from the instructions so it can be reworded
// or dropped without touching the skill content. One skill reads as "the" approach; several as a cluster.
export function explainInjection(skills: Skill[]): string {
  const tasks = skills.filter((s) => s.masterPrompt.trim()).map((s) => s.task);
  if (!tasks.length) return "";
  if (tasks.length === 1) return `Curated steps for "${tasks[0]}" (learned from prior runs):`;
  return `Curated steps from related skills (${tasks.join(", ")}), from prior runs:`;
}

// Compose the two separately-supplied parts into the final injected text. Instructions are required (no
// instructions -> nothing injected); the explanation is optional framing placed above them. Pass only the
// instructions to inject the given skill with no framing.
export function injectionText(instructions: string, explanation = ""): string {
  if (!instructions.trim()) return "";
  return explanation.trim() ? `${explanation}\n\n${instructions}` : instructions;
}

// End to end: condense the turn's messages, retrieve the relevant skills, return the injection text (or null).
export async function retrieveInjection(messages: string[]): Promise<string | null> {
  const skills = (await retrieveSkills(condenseMessages(messages))).map((x) => x.skill);
  return injectionText(skillInstructions(skills), explainInjection(skills)) || null;
}
