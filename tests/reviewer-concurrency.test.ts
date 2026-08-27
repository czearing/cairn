import { test, expect } from "bun:test";
import { randomUUID } from "node:crypto";
import { verifyPlanEvidence, verifyPlanEvidenceAsync } from "../src/hosts/copilot-cli/reviewer";
import { declareContract, satisfyCriterion, clearContract } from "../src/hosts/copilot-cli/contract";

test("reviewer context isolation: separate invocations do not leak context or bias decisions", () => {
  delete process.env.CAIRN_REVIEWER_MOCK;
  const sessionA = randomUUID();
  const sessionB = randomUUID();

  try {
    declareContract(["Export video footage evidence"], sessionA);
    declareContract(["Implement vector serialization utility"], sessionB);

    // 1. Session A submits fake text log for video -> rejected
    const verdictA = satisfyCriterion(
      "Export video footage evidence",
      "Generated OutlastVR_FootageVerification.log documenting 150 frames of camera movement",
      sessionA,
    );
    expect(verdictA.error).toBeDefined();
    expect(verdictA.error).toContain("reviewer rejected completion");

    // 2. Session B immediately follows with valid evidence for a completely different task
    // Zero context from Session A leaks into Session B
    const verdictB = satisfyCriterion(
      "Implement vector serialization utility",
      "Implemented encodeVector with Float32Array conversion in src/core/vector.ts",
      sessionB,
    );
    expect(verdictB.error).toBeUndefined();
    expect(verdictB.remaining).toEqual([]);
  } finally {
    process.env.CAIRN_REVIEWER_MOCK = "approve";
    clearContract(sessionA);
    clearContract(sessionB);
  }
}, 90_000);

test("concurrent multi-session reviewer execution: multiple subagents evaluate simultaneously without queuing", async () => {
  delete process.env.CAIRN_REVIEWER_MOCK;
  const session1 = randomUUID();
  const session2 = randomUUID();
  const session3 = randomUUID();

  try {
    declareContract(["Implement vector serialization utility"], session1);
    declareContract(["Implement memory scanner header"], session2);
    declareContract(["Research vector indexing algorithm"], session3);

    const startTime = Date.now();

    // Launch 3 reviewer evaluations concurrently in parallel
    const [result1, result2, result3] = await Promise.all([
      // Session 1: valid real code
      verifyPlanEvidenceAsync(
        "Implement vector serialization utility",
        "Implemented encodeVector with Float32Array conversion in src/core/vector.ts",
      ),
      // Session 2: fake non-existent file
      verifyPlanEvidenceAsync(
        "Implement memory scanner header",
        "Implemented MemoryScanner in src/fake_scanner_nonexistent_xyz.h",
      ),
      // Session 3: valid concrete research citations
      verifyPlanEvidenceAsync(
        "Research vector indexing algorithm",
        "Audited src/core/vector-index.ts and src/core/embed.ts: identified cosine loop unrolling and sqlite-vec handle reuse across exactVectorCandidates.",
      ),
    ]);

    const duration = Date.now() - startTime;
    console.log(`Parallel execution of 3 subagents completed in ${duration}ms`);

    // Session 1: approved (real code)
    expect(result1.approved).toBe(true);
    expect(result1.source).toBe("subagent");

    // Session 2: rejected (fake file)
    expect(result2.approved).toBe(false);
    expect(result2.source).toBe("subagent");

    // Session 3: approved (real audit)
    expect(result3.approved).toBe(true);
    expect(result3.source).toBe("subagent");
  } finally {
    process.env.CAIRN_REVIEWER_MOCK = "approve";
    clearContract(session1);
    clearContract(session2);
    clearContract(session3);
  }
}, 120_000);
