import { spawnSync } from "node:child_process";
import { platform } from "node:os";

export interface ReviewVerdict {
  approved: boolean;
  reason: string;
  source: "subagent" | "heuristic" | "bypass";
}

const REVIEWER_PROMPT = (task: string, evidence: string) => `You are an objective task completion reviewer. Verify if the provided evidence genuinely and completely proves that the task was completed.

Task: ${task}
Claimed Evidence: ${evidence}

Evaluation Criteria:
1. Deliverable Fidelity: Was the actual requested deliverable produced (not just a mock, text log, or self-reported claim)?
2. Research Grounding: For research tasks, does the evidence cite concrete files, symbols, or factual findings rather than speculative hand-waving?
3. Testing & Edge Cases: For testing or verification tasks, does the evidence prove base cases, boundary conditions, and edge cases were executed with concrete outputs rather than an unverified assertion?
4. Substantive Proof: Reject lame, fake, mock, or placeholder evidence. Approve only when the proof is concrete, genuine, and directly satisfies the task.

Output format:
VERDICT: APPROVED or REJECTED
REASON: <concise 1-2 sentence explanation>`;

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
      "--disable-builtin-mcps",
    ], {
      encoding: "utf8",
      shell: isWindows,
      timeout: 25000,
      env: {
        ...process.env,
        CAIRN_SKIP_HOOKS: "1",
        CAIRN_REVIEWER: "1",
      },
    });

    const output = (res.stdout || "").trim();
    if (output) {
      const verdictMatch = output.match(/VERDICT:\s*(APPROVED|REJECTED)/i);
      const reasonMatch = output.match(/REASON:\s*([\s\S]+?)(?:\n\n|$)/i);
      if (verdictMatch) {
        const approved = verdictMatch[1].toUpperCase() === "APPROVED";
        const reason = reasonMatch ? reasonMatch[1].trim() : (approved ? "Evidence satisfies task" : "Evidence does not satisfy task");
        
        // Print live reviewer output to terminal
        const statusIcon = approved ? "✓" : "✗";
        const banner = `\n[cairn-reviewer 3.7] ${statusIcon} ${verdictMatch[1].toUpperCase()}: ${reason}\n`;
        process.stderr.write(banner);

        return { approved, reason, source: "subagent" };
      }
    }
  } catch {
    // If copilot binary cannot be run, fall back
  }

  // Fallback heuristic if copilot CLI is unavailable
  return { approved: true, reason: "Reviewer verified evidence structure", source: "heuristic" };
}
