import { spawnSync, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { config } from "../../core/config";

export interface ReviewVerdict {
  approved: boolean;
  reason: string;
  source: "subagent" | "heuristic" | "bypass";
}

export function collectReviewerContext(sessionId = ""): string {
  if (!sessionId) return "";
  const parts: string[] = [];

  // 1. Read recent transcript if available in session-state
  const copilotHome = process.env.COPILOT_HOME || join(homedir(), ".copilot");
  const transcriptPath = join(copilotHome, "session-state", sessionId, "transcript.jsonl");
  if (existsSync(transcriptPath)) {
    try {
      const lines = readFileSync(transcriptPath, "utf8").trim().split("\n").filter(Boolean);
      const recent = lines.slice(-30);
      const toolRecords: string[] = [];
      for (const line of recent) {
        try {
          const entry = JSON.parse(line);
          if (entry.type === "tool.execution_complete" || entry.tool_name || entry.name) {
            const name = entry.tool_name || entry.name || entry.toolName || "tool";
            const args = entry.arguments_json || entry.args ? JSON.stringify(entry.arguments_json || entry.args).slice(0, 200) : "";
            const success = entry.success !== false;
            toolRecords.push(`- Tool Call: ${name} (success: ${success}) ${args}`);
          } else if (entry.type === "assistant.message" || entry.role === "assistant") {
            const content = typeof entry.content === "string" ? entry.content : entry.data?.content || "";
            if (content) {
              toolRecords.push(`- Assistant Message: ${content.slice(0, 250)}`);
            }
          }
        } catch { /* skip line */ }
      }
      if (toolRecords.length > 0) {
        parts.push(`Recent Session Transcript & Tool Invocations:\n${toolRecords.join("\n")}`);
      }
    } catch { /* skip */ }
  }

  // 2. Read recent tool executions from SQLite telemetry if available
  try {
    const dbPath = process.env.CAIRN_DB_PATH || config.dbPath;
    if (existsSync(dbPath)) {
      const db = new Database(dbPath);
      const rows = db.query(`
        SELECT kind, source, tool_name, success, duration_ms, ts
        FROM telemetry_events
        ORDER BY ts DESC LIMIT 15
      `).all() as { tool_name: string; success: number; duration_ms: number }[];
      db.close();
      if (rows && rows.length > 0) {
        const events = rows.filter((r) => r.tool_name).map((r) => `- Observed Tool: ${r.tool_name} (success: ${Boolean(r.success)}, duration: ${r.duration_ms}ms)`);
        if (events.length > 0 && parts.length === 0) {
          parts.push(`Telemetry Tool Executions:\n${events.join("\n")}`);
        }
      }
    }
  } catch { /* skip */ }

  return parts.join("\n\n");
}

const REVIEWER_PROMPT = (task: string, evidence: string, sessionContext = "") => `You are a strict, adversarial task verification reviewer. Your job is to actively poke holes in the claimed work, audit the code files directly using your reading tools, and catch any fake completion, unexecuted code, empty stubs, mock returns, or unmet requirements.

Task to Verify: ${task}
Claimed Evidence: ${evidence}
${sessionContext ? `\nObserved Session Tool Executions & Transcript Context:\n${sessionContext}\n` : ""}

Adversarial Verification Rules:
1. Active Codebase Inspection & Hole-Poking: Use your file/code reading tools to inspect the cited files and implementation code on disk. Actively hunt for stubs, empty function bodies, unhandled branches, fake/hardcoded return values, TODOs, or placeholder logic. If the code is incomplete or superficial, REJECT.
2. Runtime, Execution & Testing Proof: If the task requires running, launching, rendering, injecting, or testing (e.g., VR runtime, graphics pipeline, UI interaction, process hooks), verify whether real execution occurred based on observed tool calls and runnable test runners on disk. Reject self-reported claims (e.g. "verified 90 FPS", "tested 8.3M assertions") unless backed by actual runnable test files on disk, executed test runners, or real runtime command output.
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

export function verifyPlanEvidence(task: string, evidence: string, sessionId = ""): ReviewVerdict {
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

  const sessionContext = collectReviewerContext(sessionId);
  const prompt = REVIEWER_PROMPT(task, evidence, sessionContext);
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

export async function verifyPlanEvidenceAsync(task: string, evidence: string, sessionId = ""): Promise<ReviewVerdict> {
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

  const sessionContext = collectReviewerContext(sessionId);
  const prompt = REVIEWER_PROMPT(task, evidence, sessionContext);
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
