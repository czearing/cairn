import { test, expect, beforeEach, afterEach } from "bun:test";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { learnFromTranscript, reviewSnapshotDir } from "../src/skill/learn";
import { config } from "../src/core/config";
import { processReviewJob } from "../src/skill/review-worker";
import {
  claimReviewJobs,
  clearReviewJobs,
  completeReviewJob,
  acquireReviewSupervisor,
  enqueueReview,
  failReviewJob,
  heartbeatReviewJob,
  heartbeatReviewSupervisor,
  latestCopilotReview,
  listReviewJobs,
  releaseReviewSupervisor,
  reviewSupervisorActive,
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

test("review snapshots default beside the configured project database", () => {
  const previous = process.env.CAIRN_INFLIGHT_DIR;
  delete process.env.CAIRN_INFLIGHT_DIR;
  try {
    expect(reviewSnapshotDir()).toBe(join(dirname(config.dbPath), "inflight", "reviews"));
  } finally {
    if (previous === undefined) delete process.env.CAIRN_INFLIGHT_DIR;
    else process.env.CAIRN_INFLIGHT_DIR = previous;
  }
});

test("learnFromTranscript accepts a review even when worker capacity is zero", () => {
  const path = join(tmpdir(), `cairn-review-${randomUUID()}.jsonl`);
  writeFileSync(path, "{}");
  expect(learnFromTranscript(path, "haiku", { id: "job-cap", backend: "copilot" })).toBe(true);
  const job = listReviewJobs()[0]!;
  expect(job.status).toBe("pending");
  expect(job.transcriptPath).not.toBe(path);
  expect(existsSync(job.transcriptPath)).toBe(true);
  rmSync(job.transcriptPath, { force: true });
  rmSync(path, { force: true });
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

test("only one warm review supervisor owns the queue lease", () => {
  const now = Date.now();
  expect(acquireReviewSupervisor("owner-a", process.pid, now, 1000)).toBe(true);
  expect(reviewSupervisorActive(now, 1000)).toBe(true);
  expect(acquireReviewSupervisor("owner-b", process.pid, now + 500, 1000)).toBe(false);
  expect(heartbeatReviewSupervisor("owner-a", now + 700)).toBe(true);
  expect(acquireReviewSupervisor("owner-b", process.pid, now + 1200, 1000)).toBe(false);
  releaseReviewSupervisor("owner-a");
  expect(acquireReviewSupervisor("owner-b", process.pid, now + 1201, 1000)).toBe(true);
});

test("a replacement review supervisor immediately recovers orphaned running jobs", () => {
  const now = Date.now();
  enqueueReview({ id: "orphaned", skillId: "s", transcriptPath: "C:\\orphaned.jsonl", backend: "copilot", now });
  expect(acquireReviewSupervisor("owner-a", process.pid, now, 1000)).toBe(true);
  expect(claimReviewJobs(1)[0]).toEqual(expect.objectContaining({ id: "orphaned", attempts: 1 }));

  expect(acquireReviewSupervisor("owner-b", process.pid + 1_000_000, now + 1001, 1000)).toBe(true);
  expect(claimReviewJobs(1)[0]).toEqual(expect.objectContaining({
    id: "orphaned",
    status: "running",
    attempts: 2,
  }));
});

test("failed reviews retain their immutable snapshot for diagnosis", async () => {
  const path = join(tmpdir(), `cairn-failed-snapshot-${randomUUID()}.jsonl`);
  writeFileSync(path, "{}");
  enqueueReview({ id: "failed-snapshot", skillId: "missing-skill", transcriptPath: path, backend: "copilot" });
  const job = claimReviewJobs(1)[0]!;
  process.env.CAIRN_REVIEW_SNAPSHOT = "1";
  try {
    expect(await processReviewJob(job)).toBe(false);
    expect(existsSync(path)).toBe(true);
    expect(listReviewJobs()[0]).toEqual(expect.objectContaining({
      id: "failed-snapshot",
      status: "pending",
      attempts: 1,
      error: "transcript contained no reviewable deliverable",
    }));
  } finally {
    delete process.env.CAIRN_REVIEW_SNAPSHOT;
    rmSync(path, { force: true });
  }
});
