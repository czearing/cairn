import { telemetryCostSummary } from "./telemetry-cost-summary";
import { telemetryEngineSummary } from "./telemetry-engine-summary";
import { telemetryQualitySummary } from "./telemetry-quality-summary";
import { telemetryQualityVerdict } from "./telemetry-quality-verdict";

export * from "./telemetry-evaluation";
export { telemetryResultSucceeded } from "./telemetry-entities";
export * from "./telemetry-record";
export { estimatedTokens, jsonChars } from "./telemetry-size";
export { promptFingerprint, releaseFingerprint } from "./release";

export function telemetrySummary(days = 7) {
  const costs = telemetryCostSummary(days);
  const engine = telemetryEngineSummary(days);
  const behavior = telemetryQualitySummary(days);
  const verdict = telemetryQualityVerdict(behavior, engine);
  return {
    ...costs,
    engine,
    quality: {
      ...behavior,
      infrastructure: engine,
      verdict,
    },
  };
}
