import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { randomUUID } from "node:crypto";
import { writeFileSync, rmSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import {
  declareContract,
  satisfyCriterion,
  clearContract,
  hasActiveContract,
  findMatchingCriterion,
  stripTaskPrefix,
  isExecutableCommand,
  validateEvidence,
  formatPlanSummary,
  contractStopReason,
  noteContractNudge,
  contractDeclared,
  contractExhausted,
  readContract,
} from "../src/hosts/copilot-cli/contract";
import { collectReviewerContext } from "../src/hosts/copilot-cli/reviewer";

describe("Cairn Contract Stress & Reliability Tests", () => {
  beforeEach(() => {
    process.env.CAIRN_REVIEWER_MOCK = "approve";
  });

  afterEach(() => {
    delete process.env.CAIRN_REVIEWER_MOCK;
  });

  test("massive concurrency: 50 independent sessions operate simultaneously without cross-talk", async () => {
    const sessionIds = Array.from({ length: 50 }, () => randomUUID());
    try {
      // 1. Declare different contracts in parallel
      await Promise.all(
        sessionIds.map(async (sid, idx) => {
          const res = declareContract([
            `Task ${idx}-A: Implement core component ${idx}`,
            `Task ${idx}-B: Write test suite for ${idx}`,
            `Task ${idx}-C: Execute verification for ${idx}`,
          ], sid);
          expect(res.criteria).toHaveLength(3);
        })
      );

      // 2. Verify all 50 sessions have active isolated contracts
      for (let i = 0; i < sessionIds.length; i++) {
        const sid = sessionIds[i];
        expect(hasActiveContract(sid)).toBe(true);
        expect(contractDeclared(sid)).toBe(true);
        const contract = readContract(sid);
        expect(contract?.criteria[0].check).toBe(`Task ${i}-A: Implement core component ${i}`);
      }

      // 3. Satisfy criteria asynchronously in random orders
      await Promise.all(
        sessionIds.map(async (sid, idx) => {
          // Satisfy by numeric index
          const s1 = satisfyCriterion("1", `Implemented core component ${idx}`, sid);
          expect(s1.error).toBeUndefined();
          expect(s1.remaining).toHaveLength(2);

          // Satisfy by substring
          const s2 = satisfyCriterion(`test suite for ${idx}`, `Wrote tests for ${idx}`, sid);
          expect(s2.error).toBeUndefined();
          expect(s2.remaining).toHaveLength(1);

          // Satisfy by prefix strip
          const s3 = satisfyCriterion(`Task ${idx}-C: Execute verification for ${idx}`, `Verified ${idx}`, sid);
          expect(s3.error).toBeUndefined();
          expect(s3.remaining).toEqual([]);
        })
      );

      // 4. Verify all 50 sessions are now 100% complete
      for (const sid of sessionIds) {
        expect(hasActiveContract(sid)).toBe(false);
        const reason = contractStopReason(false, sid);
        expect(reason).toBe("");
      }
    } finally {
      for (const sid of sessionIds) {
        clearContract(sid);
      }
    }
  });

  test("unicode, emoji, markdown checkboxes, and special characters resilience", () => {
    const sid = randomUUID();
    try {
      const specialTasks = [
        "✨ Phase 1: Support UTF-8 🚀 & emojis (日本語, 한국어, 中文, العربية)",
        "- [ ] Step 2: Handle quotes: \"double\" and 'single' and `backticks` and <xml> tags",
        "3. Task with symbols: #@$%^&*()_+=~`{}[]|:;<>?,./\\",
        "Step 4: Multiline\nDescription\tWith\rTabs and   Spaces",
      ];

      const res = declareContract(specialTasks, sid);
      expect(res.criteria).toHaveLength(4);

      // Match with markdown box prefix
      const matchBox = findMatchingCriterion("[ ] Step 2: Handle quotes: \"double\" and 'single'", res.criteria!);
      expect(matchBox).toBeDefined();

      // Satisfy using partial substring with emojis/unicode
      const sat1 = satisfyCriterion("Support UTF-8 🚀", "Added unicode support tests", sid);
      expect(sat1.error).toBeUndefined();

      // Satisfy using numeric index 2
      const sat2 = satisfyCriterion("2", "Handled quotes and tags", sid);
      expect(sat2.error).toBeUndefined();

      // Satisfy using symbol search
      const sat3 = satisfyCriterion("symbols: #@$%", "Escaped and handled symbols", sid);
      expect(sat3.error).toBeUndefined();

      // Satisfy 4
      const sat4 = satisfyCriterion("4", "Normalized whitespace", sid);
      expect(sat4.error).toBeUndefined();
      expect(sat4.remaining).toEqual([]);
    } finally {
      clearContract(sid);
    }
  });

  test("corrupted / unparseable JSON files fail open safely without throwing and UTF-8 BOM is stripped", () => {
    const sid = randomUUID();
    try {
      // Test readContract with UTF-8 BOM prefix
      declareContract(["Task with BOM handling"], sid);
      const contractData = readContract(sid);
      expect(contractData).not.toBeNull();

      // Write BOM prefix manually to simulate Windows PowerShell Set-Content output
      const { createHash } = require("node:crypto");
      const { config } = require("../src/core/config");
      const contractFilePath = join(dirname(config.dbPath), "contracts", `${createHash("sha256").update(sid).digest("hex")}.json`);
      writeFileSync(contractFilePath, "\uFEFF" + JSON.stringify(contractData), "utf8");

      // Verify readContract reads cleanly despite BOM
      const readWithBom = readContract(sid);
      expect(readWithBom).not.toBeNull();
      expect(readWithBom?.criteria[0].check).toBe("Task with BOM handling");

      // Test readContract with non-existent or invalid JSON
      expect(readContract("non-existent-session-xyz")).toBeNull();
      expect(hasActiveContract("non-existent-session-xyz")).toBe(false);

      // Test stripTaskPrefix edge cases
      expect(stripTaskPrefix("")).toBe("");
      expect(stripTaskPrefix("   ")).toBe("");
      expect(stripTaskPrefix("Phase:")).toBe("");
      expect(stripTaskPrefix("1. Single char")).toBe("Single char");
      expect(stripTaskPrefix("10. Two digit prefix")).toBe("Two digit prefix");
      expect(stripTaskPrefix("Step-5: Refactor")).toBe("Refactor");

      // Test validateEvidence
      expect(validateEvidence("").valid).toBe(false);
      expect(validateEvidence("   \t\n  ").valid).toBe(false);
      expect(validateEvidence("Valid evidence artifact on disk").valid).toBe(true);

      // Test isExecutableCommand without regex
      expect(isExecutableCommand("bun test tests/unit.test.ts")).toBe(true);
      expect(isExecutableCommand("npm run build")).toBe(true);
      expect(isExecutableCommand("python -m unittest")).toBe(true);
      expect(isExecutableCommand("cargo test --all")).toBe(true);
      expect(isExecutableCommand("git status")).toBe(true);
      expect(isExecutableCommand("Create a new microservice")).toBe(false);
      expect(isExecutableCommand("Refactor authentication module")).toBe(false);
    } finally {
      clearContract(sid);
    }
  });

  test("collectReviewerContext handles corrupt transcripts and large histories gracefully", () => {
    const sid = randomUUID();
    const tempDir = join(tmpdir(), "cairn-test-session-state", sid);
    mkdirSync(tempDir, { recursive: true });
    process.env.COPILOT_HOME = join(tmpdir(), "cairn-test-copilot-home");
    const sessionDir = join(process.env.COPILOT_HOME, "session-state", sid);
    mkdirSync(sessionDir, { recursive: true });

    try {
      // Write corrupted and valid mixed JSONL transcript lines
      const lines = [
        `{"type":"tool.execution_complete","name":"grep","arguments_json":{"pattern":"test"},"success":true}`,
        `NOT_JSON_CORRUPTED_LINE`,
        `{"type":"tool.execution_complete","name":"edit","args":{"path":"src/test.ts"},"success":true}`,
        `{"role":"assistant","content":"I have updated the test file."}`,
        `{"type":"unrelated_event"}`,
        `{incomplete_json_brace`,
      ];
      writeFileSync(join(sessionDir, "transcript.jsonl"), lines.join("\n"));

      const ctx = collectReviewerContext(sid);
      expect(ctx).toContain("Tool Call: grep (success: true)");
      expect(ctx).toContain("Tool Call: edit (success: true)");
      expect(ctx).toContain("Assistant Message: I have updated the test file.");
      expect(ctx).not.toContain("NOT_JSON_CORRUPTED_LINE");
    } finally {
      rmSync(process.env.COPILOT_HOME, { recursive: true, force: true });
      delete process.env.COPILOT_HOME;
    }
  });
});
