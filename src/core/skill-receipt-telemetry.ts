import { recordTelemetryState } from "./telemetry-record";
import type { TelemetryHost } from "./telemetry-record-types";
import { receiptStepsBySkill } from "./skill-receipt";

interface ReceiptEvidence {
  complete: boolean;
  duplicate: boolean;
  reportedSteps: number;
  expectedSteps: number;
  receiptText: string;
}

/** Resolves whatever the agent named in skill_select — an id or a title — to the stored title. */
async function skillIdentities(ids: string[]): Promise<{ id: string; title: string }[]> {
  const unique = [...new Set(ids.filter(Boolean))];
  try {
    // Imported lazily: receipt telemetry must never be the reason a turn fails.
    const store = await import("../skill/store");
    return unique.map((raw) => {
      const found = store.getSkill(store.resolveSkillId(raw)) ?? store.skillByLabel(store.normalizeLabel(raw));
      return { id: found?.id ?? raw, title: found?.task ?? raw };
    });
  } catch { return unique.map((id) => ({ id, title: id })); }
}

/**
 * Records what a turn's receipt proved, including WHICH steps of WHICH skill it cited.
 *
 * The per-step events are the point. A single count told us receipts existed but not whether a skill's
 * later steps were ever reached, so a step could be added and never used and nothing would show it.
 * One event per (skill, step) makes an uncited step visible without asking a model to judge anything.
 */
export function recordSkillReceiptTelemetry(input: {
  host: TelemetryHost;
  sessionId: string;
  turnSeq: number;
  receiptKey: string;
  receipt: ReceiptEvidence;
  selectedSkillIds: string[];
}): Promise<void> {
  const { host, sessionId, turnSeq, receiptKey, receipt } = input;
  recordTelemetryState({
    host, sessionId, turnSeq, eventKey: receiptKey, kind: "skill_receipt_checked",
    success: receipt.complete, itemCount: receipt.reportedSteps, value: receipt.expectedSteps,
  });
  if (receipt.duplicate) {
    recordTelemetryState({
      host, sessionId, turnSeq, eventKey: `${receiptKey}:duplicate`, kind: "skill_receipt_duplicate",
    });
  }
  return recordCitedSteps(input);
}

async function recordCitedSteps(input: {
  host: TelemetryHost; sessionId: string; turnSeq: number; receiptKey: string;
  receipt: ReceiptEvidence; selectedSkillIds: string[];
}): Promise<void> {
  const { host, sessionId, turnSeq, receiptKey, receipt } = input;
  const identities = await skillIdentities(input.selectedSkillIds);
  for (const cited of receiptStepsBySkill(receipt.receiptText, identities)) {
    for (const step of cited.steps) {
      recordTelemetryState({
        host, sessionId, turnSeq,
        eventKey: `${receiptKey}:step:${step}`,
        kind: "skill_step_cited",
        entityType: "skill",
        entityId: cited.title,        // hashed the same way skill_selected hashes it, so the two join
        value: step,
        itemCount: cited.steps.length,
      });
    }
  }
}
