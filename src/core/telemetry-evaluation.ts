import { createHash } from "node:crypto";
import type { PromptEvaluation } from "../prompt-eval/types";
import { telemetryDatabase } from "./telemetry-schema";

const hash = (value: string): string =>
  createHash("sha256").update(value).digest("hex").slice(0, 32);

export function recordPromptEvaluation(result: PromptEvaluation): void {
  try {
    const db = telemetryDatabase();
    if (!db) return;
    const createdTs = Date.now();
    const evaluationId = hash([
      result.baselinePromptHash,
      result.candidatePromptHash,
      result.qualityDefinitionHash,
      createdTs,
    ].join("\0"));
    db.query(`INSERT INTO telemetry_evaluations(
      evaluation_id,baseline_prompt_hash,candidate_prompt_hash,quality_definition_hash,
      accepted,token_reduction,safe_token_reduction,quality_improvements,
      quality_checks,compared_runs,created_ts
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
      evaluationId, result.baselinePromptHash, result.candidatePromptHash,
      result.qualityDefinitionHash, Number(result.accepted), result.tokenReduction,
      result.safeTokenReduction, result.qualityImprovements, result.qualityChecks,
      result.comparedRuns, createdTs,
    );
  } catch { /* telemetry never blocks evaluation */ }
}
