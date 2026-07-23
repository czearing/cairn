import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const hash = (value: string, length = 24): string =>
  createHash("sha256").update(value).digest("hex").slice(0, length);

const packageVersion = (() => {
  try {
    return String(JSON.parse(
      readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
    ).version || "");
  } catch {
    return "";
  }
})();

const sourceRevision = (() => {
  try {
    const git = new URL("../../.git/", import.meta.url);
    const head = readFileSync(new URL("HEAD", git), "utf8").trim();
    const revision = head.startsWith("ref:")
      ? readFileSync(new URL(head.slice(5).trim(), git), "utf8").trim()
      : head;
    return /^[0-9a-f]{40}$/i.test(revision) ? revision.slice(0, 12) : "";
  } catch {
    return "";
  }
})();

export const releaseVersion = sourceRevision
  ? `${packageVersion}+${sourceRevision.slice(0, 7)}`
  : packageVersion;

export const promptFingerprint = (value: string): string => hash(value);

export const releaseFingerprint = (
  promptHash: string,
  catalogVersion: string,
): string => hash(
  `${process.env.CAIRN_RELEASE || sourceRevision || packageVersion}\0${promptHash}\0${catalogVersion}`,
);

export type TelemetryRunClass = "human" | "benchmark" | "worker";

export const telemetryRunClass = (): TelemetryRunClass => {
  if (process.env.CAIRN_PROMPT_BENCHMARK_SESSION) return "benchmark";
  if (process.env.CAIRN_SKILL_WORKER === "1") return "worker";
  return "human";
};
