import { telemetryCostSummary } from "./telemetry-cost-summary";
import { telemetryQualitySummary } from "./telemetry-quality-summary";

export * from "./telemetry-evaluation";
export { telemetryResultSucceeded } from "./telemetry-entities";
export * from "./telemetry-record";
export { estimatedTokens, jsonChars } from "./telemetry-size";
export { promptFingerprint, releaseFingerprint } from "./release";

export function telemetrySummary(days = 7) {
  return {
    ...telemetryCostSummary(days),
    quality: telemetryQualitySummary(days),
  };
}
