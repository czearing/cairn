import { expect, test } from "bun:test";
import { telemetryDatabase } from "../src/core/telemetry-schema";
import { telemetryQualitySummary } from "../src/core/telemetry-quality-summary";

// Behavior rates stay scoped to one release so a fixed outage stops degrading the verdict. Sample SIZE
// was then made a selection gate, which reintroduced staleness: with a release per commit, "the largest
// sample" is always the oldest one, so a months-old release spoke for the current one indefinitely and
// its long-fixed outage held the banner. Size is now a DISCLOSURE, not a gate.
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

test("the newest release speaks for itself even when an older release has more runs", () => {
  seedRuns([
    { version: "0.1.0+aaaaaaa", runs: 40 },
    { version: "0.1.0+bbbbbbb", runs: 2 },
  ]);
  const summary = telemetryQualitySummary(7);
  // Deferring to the 40-run release would report rates the current code never produced.
  expect(summary.sampleVersion).toBe("0.1.0+bbbbbbb");
  expect(summary.runs).toBe(2);
  expect(summary.populationRuns).toBe(42);
  // The thin sample must still be visible to the reader rather than silently swapped away.
  expect(summary.runs).toBeLessThan(summary.minimumSample);
});

test("a small newest sample is disclosed against the full window population", () => {
  seedRuns([
    { version: "0.1.0+ccccccc", runs: 6 },
    { version: "0.1.0+ddddddd", runs: 3 },
    { version: "0.1.0+eeeeeee", runs: 2 },
  ]);
  const summary = telemetryQualitySummary(7);
  expect(summary.sampleVersion).toBe("0.1.0+eeeeeee");
  expect(summary.runs).toBe(2);
  expect(summary.populationRuns).toBe(11);
});

test("the population is always reported alongside the scoped sample", () => {
  seedRuns([{ version: "0.1.0+fffffff", runs: 25 }]);
  const summary = telemetryQualitySummary(7);
  expect(summary.runs).toBe(25);
  expect(summary.populationRuns).toBe(25);
});
