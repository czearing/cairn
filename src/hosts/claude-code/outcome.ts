// The oracle. Reads ONE turn of a Claude Code transcript and reports: which case the turn used (the
// top brain_search result), whether it verifiably succeeded (a passing test/build in-turn), and how
// many steps it took. Pure over parsed JSONL objects so it tests with fixtures, no files. Conservative:
// success is true ONLY on a clear pass with no failure, false on a clear failure, else null (no signal,
// so the case is NOT reinforced — we never reinforce on a guess).

export interface TurnOutcome { usedCaseId: string | null; success: boolean | null; steps: number }

type Obj = { type?: string; message?: { content?: unknown } };

// A clear pass/fail in tool output. Strong signals only — bare "error" is too noisy to count.
const PASS = /\b0 fail|\btests? pass|\ball pass|build succeeded|✓ pass/i;
const FAIL = /\b[1-9]\d* fail|exit code [1-9]|\bFAILED\b|✗/i;

const resultText = (content: unknown): string =>
  typeof content === "string" ? content
    : Array.isArray(content) ? content.map((p) => (typeof p === "string" ? p : ((p as { text?: string })?.text ?? ""))).join(" ")
    : "";

// Top result id of a brain_search tool_result payload (the case the agent was handed).
function topId(text: string): string | null {
  try { const j = JSON.parse(text); return Array.isArray(j) && typeof j[0]?.id === "string" ? j[0].id : null; } catch { return null; }
}

// Start of the current turn: the line after the last string-content user message (same rule the rest of
// the host code uses to scope "this turn").
function turnStart(objs: Obj[]): number {
  for (let i = objs.length - 1; i >= 0; i--) {
    if (objs[i]?.type === "user" && typeof objs[i]?.message?.content === "string") return i + 1;
  }
  return 0;
}

export function outcomeFromObjs(objs: Obj[]): TurnOutcome {
  const turn = objs.slice(turnStart(objs));
  const toolName = new Map<string, string>(); // tool_use_id -> tool name
  let steps = 0, usedCaseId: string | null = null, pass = 0, fail = 0;
  for (const o of turn) {
    const content = o?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const part of content as Array<Record<string, unknown>>) {
      if (part?.type === "tool_use") {
        steps++;
        if (typeof part.id === "string" && typeof part.name === "string") toolName.set(part.id, part.name);
      } else if (part?.type === "tool_result") {
        const text = resultText(part.content);
        if ((toolName.get(part.tool_use_id as string) ?? "").includes("brain_search")) {
          const id = topId(text); if (id) usedCaseId = id;
        }
        if (PASS.test(text)) pass++;
        if (FAIL.test(text)) fail++;
      }
    }
  }
  const success = pass > 0 && fail === 0 ? true : fail > 0 ? false : null;
  return { usedCaseId, success, steps };
}

// File wrapper: parse the JSONL transcript and report the latest turn's outcome. Fail-safe to a no-op
// outcome on any read/parse error (never reinforce on uncertainty).
export async function turnOutcome(transcriptPath: string): Promise<TurnOutcome> {
  let text: string;
  try { text = await (await import("node:fs/promises")).readFile(transcriptPath, "utf8"); }
  catch { return { usedCaseId: null, success: null, steps: 0 }; }
  const objs = text.split("\n").filter(Boolean)
    .map((l) => { try { return JSON.parse(l) as Obj; } catch { return null; } })
    .filter((o): o is Obj => o !== null);
  return outcomeFromObjs(objs);
}
