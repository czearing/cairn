#!/usr/bin/env bun
import { randomUUID } from "node:crypto";
import {
  acquireReviewSupervisor,
  claimReviewJobs,
  heartbeatReviewSupervisor,
  releaseReviewSupervisor,
} from "../src/skill/review-queue";
import { processReviewJob } from "../src/skill/review-worker";
import { stopCopilotSdk } from "../src/skill/copilot-sdk";

process.env.CAIRN_SKILL_WORKER = "1";
process.env.CAIRN_WARM_LEARNER = "1";

const owner = randomUUID();
const concurrency = Math.max(1, Number(process.env.CAIRN_MAX_LEARNERS || "4"));
const idleMs = Math.max(1000, Number(process.env.CAIRN_REVIEW_SUPERVISOR_IDLE_MS || "300000"));
const pollMs = Math.max(50, Number(process.env.CAIRN_REVIEW_SUPERVISOR_POLL_MS || "250"));
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

if (!acquireReviewSupervisor(owner, process.pid)) process.exit(0);

let idleSince = Date.now();
let ownershipLost = false;
const heartbeat = setInterval(() => {
  try {
    if (!heartbeatReviewSupervisor(owner)) ownershipLost = true;
  } catch {
    ownershipLost = true;
  }
}, Math.max(1000, Math.floor(Number(process.env.CAIRN_REVIEW_SUPERVISOR_STALE_MS || "30000") / 3)));
try {
  while (!ownershipLost && Date.now() - idleSince < idleMs) {
    const jobs = claimReviewJobs(concurrency);
    if (!jobs.length) {
      await sleep(pollMs);
      continue;
    }
    idleSince = Date.now();
    await Promise.all(jobs.map(processReviewJob));
  }
} finally {
  clearInterval(heartbeat);
  await stopCopilotSdk();
  releaseReviewSupervisor(owner);
}
process.exit(0);
