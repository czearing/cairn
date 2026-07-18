import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { appendFileSync, copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { config } from "../core/config";
import { copilotReviews, enqueueReview, latestCopilotReview, reviewSupervisorActive, transcriptReviewKey } from "./review-queue";

// The async learn trigger. After a turn finishes, the WHOLE skill-forming process (extract the run ->
// learn: label + grade + master, with the raw transcript as context -> categorize -> store) runs in a
// DETACHED background process so it outlives the short Stop hook and never blocks the user.
//
// Loop guard (critical): the learner must never kick off its own skill-forming, or it would recurse
// forever. Two layers stop it: the spawned worker runs `claude -p --setting-sources project` so cairn's
// hooks do not fire inside it, AND CAIRN_SKILL_WORKER=1 is set on the worker so any nested trigger no-ops.
//
// Review submission is durable: callers enqueue first, then a bounded worker pool drains pending jobs.
// Capacity delays a review but never drops it or makes agentStop claim the turn was not reviewed.

export function isSkillWorker(): boolean {
  return process.env.CAIRN_SKILL_WORKER === "1";
}

const SUPERVISOR = () => process.env.CAIRN_REVIEW_SUPERVISOR_PATH || fileURLToPath(new URL("../../scripts/skill-review-supervisor.ts", import.meta.url));
const MAX_LEARNERS = () => Number(process.env.CAIRN_MAX_LEARNERS || "4");
export const reviewSnapshotDir = (): string =>
  join(process.env.CAIRN_INFLIGHT_DIR || join(dirname(config.dbPath), "inflight"), "reviews");
export interface CopilotReviewContext {
  requests: string[];
  startTs: number;
}

function snapshotTranscript(transcriptPath: string, id: string, context?: CopilotReviewContext): string {
  const name = `${createHash("sha256").update(id).digest("hex")}.jsonl`;
  const destination = join(reviewSnapshotDir(), name);
  if (!existsSync(destination)) {
    mkdirSync(reviewSnapshotDir(), { recursive: true });
    copyFileSync(transcriptPath, destination);
    if (context?.requests.length) {
      appendFileSync(destination, `\n${JSON.stringify({
        type: "cairn.review_context",
        timestamp: Date.now(),
        data: context,
      })}\n`);
    }
  }
  return destination;
}

function spawnSupervisor(): boolean {
  try {
    const child = spawn(process.platform === "win32" ? "bun.exe" : "bun", [SUPERVISOR()], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: {
        ...process.env,
        CAIRN_SKILL_WORKER: "1",
        CAIRN_WARM_LEARNER: "1",
        CAIRN_READONLY: "",
        CAIRN_REVIEW_SNAPSHOT: "1",
      },
    });
    child.unref();
    return true;
  } catch { return false; }
}

export function drainReviewQueue(): number {
  if (MAX_LEARNERS() <= 0 || reviewSupervisorActive()) return 0;
  return spawnSupervisor() ? 1 : 0;
}

export function learnFromTranscript(
  transcriptPath: string,
  skillId: string,
  options: { id?: string; sessionId?: string; backend?: string; reviewContext?: CopilotReviewContext } = {}
): boolean {
  if (isSkillWorker() || !transcriptPath || !skillId.trim()) return false;
  try {
    const sessionId = options.sessionId ?? "";
    const id = options.id ?? transcriptReviewKey(transcriptPath, skillId, sessionId);
    const jobTranscriptPath = snapshotTranscript(transcriptPath, id, options.reviewContext);
    const accepted = enqueueReview({
      id,
      sessionId,
      skillId,
      transcriptPath: jobTranscriptPath,
      backend: options.backend ?? process.env.CAIRN_LEARN_BACKEND ?? "copilot",
    }).accepted;
    if (!accepted) return false;
    drainReviewQueue();
    return true;
  } catch { return false; }
}

export function learnLatestCopilotReview(
  transcriptPath: string,
  sessionId: string,
  options: { skillId?: string; agentId?: string; agentName?: string; subagentOnly?: boolean } = {}
): boolean {
  const event = latestCopilotReview(transcriptPath, sessionId, options);
  if (!event) return false;
  return learnFromTranscript(transcriptPath, event.skillId, {
    id: event.id,
    sessionId,
    backend: "copilot",
  });
}

export function learnCopilotReviews(
  transcriptPath: string,
  sessionId: string,
  options: { skillId?: string; agentId?: string; agentName?: string; subagentOnly?: boolean } = {}
): boolean {
  const reviews = copilotReviews(transcriptPath, sessionId, options);
  if (!reviews.length) return false;
  return reviews.every((review) => learnFromTranscript(transcriptPath, review.skillId, {
    id: review.id,
    sessionId,
    backend: "copilot",
  }));
}
