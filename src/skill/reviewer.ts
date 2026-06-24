import { runClaude } from "./claude";
import { cairnMcpConfigPath } from "./cairn-mcp";
import { REVIEW_SYSTEM, reviewUserPrompt } from "./prompts";
import { topRuns, hasSession, markSession } from "./store";
import type { Review } from "./types";

// The reviewer: one cairn-connected Claude that judges an output for a skill against the skill's prior
// runs, scoring quality far above speed. Its conversation PERSISTS per skill: the first review starts a
// session under the skill id, and every later review --resumes it, so the same reviewer remembers what
// worked and what did not across runs (the user's "pull up that same conversation" requirement). There is
// one reviewer at a time, so a caller with several skills reviews them serially.

// Pure: extract and validate the reviewer's JSON verdict. Returns null on junk or an out-of-range score.
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

/** Review `output` for the skill, with its top prior runs as context. Persists/restores the skill's
 *  reviewer session. Returns the verdict, or null if the run failed or did not produce valid JSON. */
export async function reviewOutput(skillId: string, task: string, output: string, timeoutMs?: number): Promise<Review | null> {
  const resuming = hasSession(skillId);
  const res = await runClaude(reviewUserPrompt(task, output, topRuns(skillId, 10)), {
    system: REVIEW_SYSTEM,
    mcpConfigPath: cairnMcpConfigPath(),
    allowedTools: ["mcp__cairn__brain_search"],
    resume: resuming ? skillId : undefined,
    sessionId: resuming ? undefined : skillId,
    timeoutMs,
  });
  if (res.ok && !resuming) markSession(skillId); // session now exists; later reviews resume it
  return parseReview(res.text);
}
