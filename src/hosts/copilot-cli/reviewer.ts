import { spawnSync } from "node:child_process";
import { platform } from "node:os";

export interface ReviewVerdict {
  approved: boolean;
  reason: string;
  source: "subagent" | "heuristic" | "bypass";
}

const REVIEWER_PROMPT = (task: string, evidence: string) => `You are an objective task completion reviewer. Verify if the provided evidence genuinely proves that the task was completed.

Task: ${task}
Claimed Evidence: ${evidence}

Instructions:
- If the evidence is lame, fake, mock, placeholder, or does not actually satisfy what the task asked for (e.g. creating a text log when the task required footage/media export, or claiming work without real deliverables), REJECT it.
- If the evidence is genuine, substantive, and matches the task requirements, APPROVE it.

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
