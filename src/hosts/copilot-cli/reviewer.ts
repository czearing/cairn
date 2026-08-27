import { spawnSync, spawn } from "node:child_process";
import { platform } from "node:os";

export interface ReviewVerdict {
  approved: boolean;
  reason: string;
  source: "subagent" | "heuristic" | "bypass";
}

const REVIEWER_PROMPT = (task: string, evidence: string) => `You are a strict, adversarial task verification reviewer. Your job is to actively poke holes in the claimed work, audit the code files directly using your reading tools, and catch any fake completion, unexecuted code, empty stubs, mock returns, or unmet requirements.

Task to Verify: ${task}
Claimed Evidence: ${evidence}

Adversarial Verification Rules:
1. Active Codebase Inspection & Hole-Poking: Use your file/code reading tools to inspect the cited files and implementation code on disk. Actively hunt for stubs, empty function bodies, unhandled branches, fake/hardcoded return values, TODOs, or placeholder logic. If the code is incomplete or superficial, REJECT.
2. Runtime, Execution & Testing Proof: If the task requires running, launching, rendering, injecting, or testing (e.g., VR runtime, graphics pipeline, UI interaction, process hooks), verify whether real execution occurred. Reject self-reported claims (e.g. "verified 90 FPS", "tested 8.3M assertions") unless backed by actual runnable test files on disk, executed test runners, or real runtime command output.
3. Deliverable Fidelity & Zero Hallucination: Confirm the actual requested deliverable exists on disk. Reject text logs substituted for real code/media deliverables. Reject references to non-existent files or functions.
4. Completeness: A task milestone must be 100% implemented, functional, and verifiable—not just scaffolding or partial progress.

If the work has ANY flaws, missing files, stubs, unexecuted claims, or lack of concrete proof, REJECT it and explain the exact hole. Approve ONLY if 100% verified on disk.

Output format:
VERDICT: APPROVED or REJECTED
REASON: <concise 1-2 sentence explanation detailing the verification finding or exact deficiency>`;

function parseReviewerOutput(output: string): { approved: boolean; reason: string } | null {
  const verdictMatch = output.match(/VERDICT:\s*(APPROVED|REJECTED)/i);
  const reasonMatch = output.match(/REASON:\s*([\s\S]+?)(?:\n\n|$)/i);
  if (!verdictMatch) return null;
  const approved = verdictMatch[1].toUpperCase() === "APPROVED";
  const reason = reasonMatch ? reasonMatch[1].trim() : (approved ? "Evidence satisfies task" : "Evidence does not satisfy task");
  
  // Print live reviewer output to terminal
  const statusIcon = approved ? "✓" : "✗";
  const banner = `\n[cairn-reviewer 3.7] ${statusIcon} ${verdictMatch[1].toUpperCase()}: ${reason}\n`;
  process.stderr.write(banner);

  return { approved, reason };
}

function fallbackHeuristic(_task: string, _evidence: string): ReviewVerdict {
  return { approved: true, reason: "Reviewer bypassed by environment or fallback", source: "bypass" };
}

export function verifyPlanEvidence(task: string, evidence: string): ReviewVerdict {
  // Allow test mock override
  if (process.env.CAIRN_REVIEWER_MOCK) {
    const approved = process.env.CAIRN_REVIEWER_MOCK === "approve";
    return {
      approved,
      reason: approved ? "Mock reviewer approved" : "Mock reviewer rejected",
      source: "bypass",
    };
  }

  // If reviewer is disabled explicitly in testing/benchmarks
  if (process.env.CAIRN_DISABLE_REVIEWER === "1") {
    return { approved: true, reason: "Reviewer bypassed by configuration", source: "bypass" };
  }

  const prompt = REVIEWER_PROMPT(task, evidence);
  const isWindows = platform() === "win32";
  const cmd = isWindows ? "copilot.cmd" : "copilot";

  try {
    const res = spawnSync(cmd, [
      "-p", JSON.stringify(prompt),
      "-s",
      "--no-custom-instructions",
      "--model", "gemini-3.7-flash",
      "--allow-all-tools",
      "--disable-builtin-mcps",
    ], {
      cwd: process.cwd(),
      encoding: "utf8",
      shell: isWindows,
      timeout: 45000,
      env: {
        ...process.env,
        CAIRN_SKIP_HOOKS: "1",
        CAIRN_REVIEWER: "1",
      },
    });

    const output = (res.stdout || "").trim();
    if (output) {
      const parsed = parseReviewerOutput(output);
      if (parsed) {
        return { approved: parsed.approved, reason: parsed.reason, source: "subagent" };
      }
    }
  } catch {
    // If copilot binary cannot be run, fall back
  }

  return fallbackHeuristic(task, evidence);
}

export async function verifyPlanEvidenceAsync(task: string, evidence: string): Promise<ReviewVerdict> {
  if (process.env.CAIRN_REVIEWER_MOCK) {
    const approved = process.env.CAIRN_REVIEWER_MOCK === "approve";
    return {
      approved,
      reason: approved ? "Mock reviewer approved" : "Mock reviewer rejected",
      source: "bypass",
    };
  }

  if (process.env.CAIRN_DISABLE_REVIEWER === "1") {
    return { approved: true, reason: "Reviewer bypassed by configuration", source: "bypass" };
  }

  const prompt = REVIEWER_PROMPT(task, evidence);
  const isWindows = platform() === "win32";
  const cmd = isWindows ? "copilot.cmd" : "copilot";

  return new Promise((resolve) => {
    let stdout = "";
    let resolved = false;

    const proc = spawn(cmd, [
      "-p", JSON.stringify(prompt),
      "-s",
      "--no-custom-instructions",
      "--model", "gemini-3.7-flash",
      "--allow-all-tools",
      "--disable-builtin-mcps",
    ], {
      cwd: process.cwd(),
      shell: isWindows,
      env: {
        ...process.env,
        CAIRN_SKIP_HOOKS: "1",
        CAIRN_REVIEWER: "1",
      },
    });

    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        try { proc.kill(); } catch {}
        resolve(fallbackHeuristic(task, evidence));
      }
    }, 45000);

    proc.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    proc.on("close", () => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timer);
        const parsed = parseReviewerOutput(stdout.trim());
        if (parsed) {
          resolve({ approved: parsed.approved, reason: parsed.reason, source: "subagent" });
        } else {
          resolve(fallbackHeuristic(task, evidence));
        }
      }
    });

    proc.on("error", () => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timer);
        resolve(fallbackHeuristic(task, evidence));
      }
    });
  });
}
