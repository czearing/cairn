import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  beginQualityRun,
  finishQualityRun,
  promptFingerprint,
  recordQualityTool,
} from "../src/core/quality-record";
import { qualityDatabase } from "../src/core/quality-schema";
import { qualitySummary } from "../src/core/quality-summary";

const identity = (sessionId: string) => ({ host: "copilot" as const, sessionId, turnSeq: 1 });

test("quality telemetry derives reuse and release deltas without storing content", () => {
  qualityDatabase()?.run("DELETE FROM quality_events");
  qualityDatabase()?.run("DELETE FROM quality_runs");
  const marker = `private-quality-${crypto.randomUUID()}`;
  const baseline = identity("quality-baseline");
  const current = identity("quality-current");
  beginQualityRun({
    ...baseline, promptHash: promptFingerprint("baseline"), catalogVersion: "catalog-a",
    injectedChars: 400, ts: Date.now() - 1000,
  });
  recordQualityTool({
    ...baseline, eventKey: "baseline-search", toolName: "brain_search",
    args: { query: marker }, result: [{ id: "node-a", text: marker }], success: true,
  });
  recordQualityTool({
    ...baseline, eventKey: "baseline-use", toolName: "brain_mutate",
    args: { id: "node-a", answer: marker }, result: { id: "node-a" }, success: true,
  });
  recordQualityTool({
    ...baseline, eventKey: "baseline-skill", toolName: "skill_select",
    args: { ids: ["skill-a"] }, result: { selected: [{ id: "skill-a" }] }, success: true,
  });
  finishQualityRun({
    ...baseline, completed: true, workflowPassed: true, skillUsed: true,
    brainUsed: true, stopNudges: 1,
  });

  beginQualityRun({
    ...current, promptHash: promptFingerprint("current"), catalogVersion: "catalog-b",
    injectedChars: 320,
  });
  recordQualityTool({
    ...current, eventKey: "current-search", toolName: "brain_search",
    args: { query: marker }, result: [{ id: "node-a", text: marker }], success: true,
  });
  recordQualityTool({
    ...current, eventKey: "current-create", toolName: "brain_create",
    args: { text: marker, edges: ["node-a"] }, result: { id: "node-b" }, success: true,
  });
  recordQualityTool({
    ...current, eventKey: "current-skill", toolName: "skill_select",
    args: { ids: ["skill-a"] }, result: { selected: [{ id: "skill-a" }] }, success: true,
  });
  recordQualityTool({
    ...current, eventKey: "current-edit", toolName: "skill_edit",
    args: { id: "skill-a", master: marker }, result: { ok: true }, success: true,
  });
  recordQualityTool({
    ...current, eventKey: "current-failure", toolName: "Edit",
    args: {}, result: { success: false }, success: false,
  });
  finishQualityRun({
    ...current, completed: true, workflowPassed: true, skillUsed: true,
    brainUsed: true, stopNudges: 0,
  });

  const summary = qualitySummary(1);
  expect(summary).toMatchObject({
    runs: 2,
    completedRate: 100,
    workflowRate: 100,
    toolFailures: 1,
    searchToUseRate: 100,
    crossSessionReuseRate: 50,
    crossSessionNodes: 1,
    observedNodes: 2,
    selectedSkills: 1,
    editedSkills: 1,
    skillEditRate: 100,
  });
  expect(summary.current).not.toBeNull();
  expect(summary.baseline).not.toBeNull();
  expect(summary.delta).not.toBeNull();

  const db = new Database(process.env.CAIRN_DB_PATH!, { readonly: true });
  const columns = db.query("PRAGMA table_info(quality_events)").all() as { name: string }[];
  const serialized = JSON.stringify(db.query("SELECT * FROM quality_events").all());
  db.close();
  expect(columns.map((column) => column.name)).not.toContain("content");
  expect(serialized).not.toContain(marker);
  expect(serialized).not.toContain("node-a");
  expect(serialized).not.toContain("skill-a");
});
