import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const hash = (value: string, length = 24): string =>
  createHash("sha256").update(value).digest("hex").slice(0, length);

export const releaseVersion = (() => {
  try {
    return String(JSON.parse(
      readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
    ).version || "");
  } catch {
    return "";
  }
})();

export const promptFingerprint = (value: string): string => hash(value);

export const releaseFingerprint = (
  promptHash: string,
  catalogVersion: string,
): string => hash(
  `${process.env.CAIRN_RELEASE || releaseVersion}\0${promptHash}\0${catalogVersion}`,
);

export type TelemetryRunClass = "human" | "benchmark" | "worker";

export const telemetryRunClass = (): TelemetryRunClass => {
  if (process.env.CAIRN_PROMPT_BENCHMARK_SESSION) return "benchmark";
  if (process.env.CAIRN_SKILL_WORKER === "1") return "worker";
  return "human";
};
