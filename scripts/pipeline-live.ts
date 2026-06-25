// Live end-to-end proof of the whole skill loop on one real request. Throwaway db:
//   CAIRN_DB_PATH=/tmp/pipe.db CAIRN_ALLOW_REAL_DB=1 bun scripts/pipeline-live.ts
import { processRun } from "../src/skill/pipeline";
import { getSkill, topRuns } from "../src/skill/store";

const input = {
  request: "can you write a PR description for my change that adds retry logic to the upload path",
  transcript: `[00:00] user: write a PR description for adding retry logic to upload
[00:02] assistant: searched the brain for prior PR description runs
[00:04] assistant: drafted summary covering what changed, why, and testing
[00:06] assistant: returned the PR description`,
  output: `## Add retry logic to the upload path

Uploads now retry up to 3 times with exponential backoff on transient network errors, so a flaky connection no longer fails the whole upload.

Testing: unit tests for the backoff schedule; manual test against a throttled endpoint.`,
};

console.log("=== full pipeline: label -> categorize -> compact -> review -> store -> assemble ===\n");
const res = await processRun(input, 1);
console.log("result:", JSON.stringify(res), "\n");
const r = res[0];
if (r) {
  console.log(`skill: ${r.task} (${r.skillId.slice(0, 8)}), created=${r.created}, score=${r.score}`);
  console.log("\nstored run recipe (compacted):\n" + topRuns(r.skillId)[0]?.recipe);
  console.log("\nassembled master prompt:\n" + (getSkill(r.skillId)?.masterPrompt ?? "(none)"));
}
