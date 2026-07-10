import { test, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { learnFromTranscript } from "../src/skill/learn";
import {
  claimReviewJobs,
  clearReviewJobs,
  completeReviewJob,
  enqueueReview,
  failReviewJob,
  heartbeatReviewJob,
  latestCopilotReview,
  listReviewJobs,
} from "../src/skill/review-queue";

beforeEach(() => {
  process.env.CAIRN_MAX_LEARNERS = "0";
  process.env.CAIRN_REVIEW_MAX_ATTEMPTS = "3";
  clearReviewJobs();
});
afterEach(() => {
  delete process.env.CAIRN_MAX_LEARNERS;
  delete process.env.CAIRN_REVIEW_MAX_ATTEMPTS;
  delete process.env.CAIRN_REVIEW_STALE_MS;
  clearReviewJobs();
});

test("learnFromTranscript accepts a review even when worker capacity is zero", () => {
  const path = join(tmpdir(), `cairn-review-${randomUUID()}.jsonl`);
  expect(learnFromTranscript(path, "haiku", { id: "job-cap", backend: "copilot" })).toBe(true);
  expect(listReviewJobs()[0]!.status).toBe("pending");
});

test("learnFromTranscript is a no-op inside a worker, with no transcript path, and with no label", () => {
  const prev = process.env.CAIRN_SKILL_WORKER;
  process.env.CAIRN_SKILL_WORKER = "1";
  expect(learnFromTranscript(join(tmpdir(), "x.jsonl"), "haiku")).toBe(false); // worker loop guard
  if (prev === undefined) delete process.env.CAIRN_SKILL_WORKER; else process.env.CAIRN_SKILL_WORKER = prev;
  expect(learnFromTranscript("", "haiku")).toBe(false);                // nothing to learn
  expect(learnFromTranscript(join(tmpdir(), "x.jsonl"), "")).toBe(false); // no declared skill -> nothing to grade
});

test("review queue is idempotent and enforces the running capacity", () => {
  for (const id of ["a", "b", "c"]) enqueueReview({ id, skillId: "s", transcriptPath: `C:\\${id}.jsonl`, backend: "copilot" });
  expect(enqueueReview({ id: "a", skillId: "s", transcriptPath: "C:\\a.jsonl", backend: "copilot" }).created).toBe(false);
  expect(listReviewJobs().length).toBe(3);
  expect(claimReviewJobs(2).map((j) => j.id)).toEqual(["a", "b"]);
  expect(claimReviewJobs(2)).toEqual([]);
  completeReviewJob("a", 1);
  expect(claimReviewJobs(2).map((j) => j.id)).toEqual(["c"]);
});

test("failed review jobs retry to the configured limit, then remain failed", () => {
  enqueueReview({ id: "retry", skillId: "s", transcriptPath: "C:\\retry.jsonl", backend: "copilot" });
  for (let attempt = 1; attempt <= 3; attempt++) {
    expect(claimReviewJobs(1)[0]!.attempts).toBe(attempt);
    expect(failReviewJob("retry", `failure ${attempt}`, attempt)).toBe(attempt < 3 ? "pending" : "failed");
  }
  const job = listReviewJobs()[0]!;
  expect(job.status).toBe("failed");
  expect(job.attempts).toBe(3);
  expect(job.error).toBe("failure 3");
});

test("a heartbeat keeps a long-running review from being reclaimed", () => {
  process.env.CAIRN_REVIEW_STALE_MS = "1";
  enqueueReview({ id: "active", skillId: "s", transcriptPath: "C:\\active.jsonl", backend: "copilot" });
  expect(claimReviewJobs(1)[0]!.attempts).toBe(1);
  heartbeatReviewJob("active", 1, Date.now() + 10_000);
  expect(claimReviewJobs(1)).toEqual([]);
  expect(listReviewJobs()[0]).toEqual(expect.objectContaining({ id: "active", status: "running", attempts: 1 }));
});

test("a recovered worker cannot overwrite the active retry", () => {
  process.env.CAIRN_REVIEW_STALE_MS = "1";
  enqueueReview({ id: "fenced", skillId: "s", transcriptPath: "C:\\fenced.jsonl", backend: "copilot" });
  expect(claimReviewJobs(1)[0]!.attempts).toBe(1);
  heartbeatReviewJob("fenced", 1, 0);
  expect(claimReviewJobs(1)[0]!.attempts).toBe(2);

  expect(heartbeatReviewJob("fenced", 1, Date.now() + 10_000)).toBe(false);
  expect(completeReviewJob("fenced", 1)).toBe(false);
  expect(failReviewJob("fenced", "late failure", 1)).toBe("running");
  expect(listReviewJobs()[0]).toEqual(expect.objectContaining({ status: "running", attempts: 2, error: "" }));
  expect(completeReviewJob("fenced", 2)).toBe(true);
});

test("a failed skill_review call is not accepted from the transcript", () => {
  const transcriptPath = join(tmpdir(), `cairn-failed-review-${randomUUID()}.jsonl`);
  writeFileSync(transcriptPath, [
    JSON.stringify({
      type: "tool.execution_start",
      timestamp: 10,
      data: { toolCallId: "failed-review", toolName: "cairn-skill_review", arguments: { id: "skill-failed" } },
    }),
    JSON.stringify({
      type: "tool.execution_complete",
      timestamp: 11,
      data: { toolCallId: "failed-review", success: false },
    }),
  ].join("\n"));
  expect(latestCopilotReview(transcriptPath, "session-failed")).toBeNull();
});
