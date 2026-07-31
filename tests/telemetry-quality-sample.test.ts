import { expect, test } from "bun:test";
import { telemetryDatabase } from "../src/core/telemetry-schema";
import { telemetryQualitySummary } from "../src/core/telemetry-quality-summary";

// Behavior rates stay scoped to one release so a fixed outage stops degrading the verdict. The defect
// was the sample SIZE: a minimum of one run pinned rates to whichever release was newest, so with a
// release per commit the verdict spoke for a handful of runs while the window held hundreds.
function seedRuns(releases: { version: string; runs: number }[]): void {
  const db = telemetryDatabase();
  if (!db) throw new Error("telemetry disabled");
  db.run("DELETE FROM telemetry_runs");
  let ts = Date.now() - 3_600_000;
  for (const [index, release] of releases.entries()) {
    for (let n = 0; n < release.runs; n++) {
      db.run(
        `INSERT INTO telemetry_runs (run_id,host,session_hash,turn_seq,release_fingerprint,version,
          run_class,started_ts,ended_ts,completed,workflow_passed,status)
         VALUES (?,?,?,?,?,?,'human',?,?,1,1,'completed')`,
        [`run-${index}-${n}`, "copilot", `s${index}`, n, `fp-${index}`, release.version, ts, ts],
      );
      ts += 1000;
    }
  }
}

test("a newest release with a token sample does not speak for the window", () => {
  seedRuns([
    { version: "0.1.0+aaaaaaa", runs: 40 },
    { version: "0.1.0+bbbbbbb", runs: 2 },
  ]);
  const summary = telemetryQualitySummary(7);
  // The 2-run release is newest but cannot carry the rates; the 40-run release does.
  expect(summary.sampleVersion).toBe("0.1.0+aaaaaaa");
  expect(summary.runs).toBe(40);
  expect(summary.populationRuns).toBe(42);
});

test("with no release meeting the minimum, the largest sample speaks and coverage is disclosed", () => {
  seedRuns([
    { version: "0.1.0+ccccccc", runs: 6 },
    { version: "0.1.0+ddddddd", runs: 3 },
    { version: "0.1.0+eeeeeee", runs: 2 },
  ]);
  const summary = telemetryQualitySummary(7);
  expect(summary.sampleVersion).toBe("0.1.0+ccccccc");
  expect(summary.runs).toBe(6);
  expect(summary.populationRuns).toBe(11);
});

test("the population is always reported alongside the scoped sample", () => {
  seedRuns([{ version: "0.1.0+fffffff", runs: 25 }]);
  const summary = telemetryQualitySummary(7);
  expect(summary.runs).toBe(25);
  expect(summary.populationRuns).toBe(25);
});
