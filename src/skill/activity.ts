import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { config } from "../core/config";
import { c } from "../term";

// The skill loop runs in a detached, invisible background worker (no terminal pops up). To keep it from
// being a black box, each run APPENDS a one-line event to a shared activity log; a single persistent
// `cairn skills` monitor tails and renders it. The log is the decoupling layer: many short-lived workers
// write, one long-lived viewer reads. It lives next to the brain db (so a temp-db test gets a temp log,
// never touching the real one) and is bounded so it can't grow without limit.

export type Phase = "start" | "learned" | "skipped" | "failed";

/** One background-learning event. `start` opens a run, then exactly one of: `learned` (a skill was graded
 *  and its master rewritten), `skipped` (the turn was genuinely not a reusable task), or `failed` (the
 *  learner CLI call errored, distinct from a deliberate skip) closes it. */
export interface Activity {
  ts: number;
  phase: Phase;
  request?: string;
  label?: string;
  score?: number;
  created?: boolean; // a brand-new skill vs an update to an existing one
  master?: boolean;  // whether the master prompt was (re)written this run
  review?: { right: string; wrong: string; improve: string }; // the learner's reasoning, for the web feed
  output?: string;   // a short preview of the deliverable the agent produced, for the web feed
  error?: string;    // the real reason a failed run failed (stderr / exit code / timeout)
}

const KEEP = 300;     // lines retained after a trim (the monitor only needs the recent tail)
const TRIM_AT = 450;  // trim once the file grows past this, so it never balloons

/** Path to the activity log, next to the brain db. Overridable for tests via CAIRN_ACTIVITY_PATH. */
export function activityPath(): string {
  return process.env.CAIRN_ACTIVITY_PATH || join(dirname(config.dbPath), "skill-activity.jsonl");
}

/** Append one event as a JSON line, trimming the file when it grows too large. Best-effort; never throws
 *  (the feed must never disrupt the background worker). */
export function recordActivity(ev: Activity): void {
  try {
    const p = activityPath();
    mkdirSync(dirname(p), { recursive: true });
    appendFileSync(p, JSON.stringify(ev) + "\n");
    const lines = readFileSync(p, "utf8").split("\n").filter(Boolean);
    if (lines.length > TRIM_AT) writeFileSync(p, lines.slice(-KEEP).join("\n") + "\n");
  } catch { /* activity feed is best-effort */ }
}

/** Read every event currently in the log (oldest first). Empty when the log is missing or unreadable.
 *  Torn lines (a half-written append) are skipped, not fatal. */
export function readActivity(): Activity[] {
  try {
    const p = activityPath();
    if (!existsSync(p)) return [];
    const out: Activity[] = [];
    for (const l of readFileSync(p, "utf8").split("\n")) {
      if (!l.trim()) continue;
      try { out.push(JSON.parse(l) as Activity); } catch { /* skip a torn line */ }
    }
    return out;
  } catch { return []; }
}

const hhmm = (ts: number): string => {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

// Quality reads at a glance: red below the AI baseline, yellow functional, green expert-to-masterwork.
const scoreColor = (s: number) => (s >= 0.7 ? c.green : s >= 0.5 ? c.yellow : c.red);
const scoreBar = (s: number): string => {
  const filled = Math.round(Math.max(0, Math.min(1, s)) * 5);
  return scoreColor(s)("▓".repeat(filled)) + c.dim("░".repeat(5 - filled));
};
const quote = (s = ""): string => {
  const t = s.replace(/\s+/g, " ").trim();
  return `"${t.length > 60 ? t.slice(0, 57) + "…" : t}"`;
};

/** Render one event as a single, friendly status line. Pure (color is handled by term.c, which no-ops on
 *  NO_COLOR / non-TTY), so it is deterministic to test. */
export function renderActivity(ev: Activity): string {
  const time = c.dim(hhmm(ev.ts));
  if (ev.phase === "start") return `${time}  ${c.cyan("✶")} reviewing  ${c.dim(quote(ev.request))}`;
  if (ev.phase === "skipped") return `${time}  ${c.dim("·")} skipped    ${c.dim("not a reusable task")}`;
  if (ev.phase === "failed") return `${time}  ${c.yellow("!")} failed     ${c.dim("learner call failed (" + (ev.error || "unknown") + ") " + quote(ev.request))}`;
  const s = ev.score ?? 0;
  const label = c.bold((ev.label ?? "?").padEnd(14));
  const tag = ev.created ? c.green("new skill") : c.dim("updated");
  const note = ev.master ? "master rewritten" : "graded";
  return `${time}  ${c.cyan("◆")} ${label} ${scoreColor(s)(s.toFixed(2))} ${scoreBar(s)}  ${tag} ${c.dim("· " + note)}`;
}
