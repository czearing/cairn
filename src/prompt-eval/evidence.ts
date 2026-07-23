import { createHash } from "node:crypto";
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { PromptHost, PromptRunEvidence } from "./types";
import {
  graphEvidence,
  normalizeToolName,
  resultIds,
  type ToolEvent,
} from "./graph-evidence";

interface HostRow {
  tool_name: string;
  raw_json: string;
}

interface BenchmarkEventRow {
  tool_name: string;
  args_json: string;
  result_json: string;
}

const liveDb = resolve(join(homedir(), ".cairn", "cairn.db"));
const hashSession = (value: string) =>
  createHash("sha256").update(value).digest("hex").slice(0, 16);

function payload(host: PromptHost, raw: string): ToolEvent {
  const row = JSON.parse(raw) as Record<string, unknown>;
  const args = (row.toolArgs ?? row.tool_input ?? {}) as Record<string, unknown>;
  const result = row.toolResult ?? row.tool_result ?? row.toolOutput ?? row.tool_output;
  return {
    args: typeof args === "object" && args ? args : {},
    result,
    name: normalizeToolName(String(row.toolName ?? row.tool_name ?? "")),
    host,
  };
}

export function capturePromptEvidence(input: {
  dbPath: string;
  host: PromptHost;
  sessionId: string;
  caseId: string;
  trial: number;
  taskAssertionSet: string;
  taskAssertionsPassed: number;
  taskAssertionsTotal: number;
}): PromptRunEvidence {
  const path = resolve(input.dbPath);
  if (path === liveDb) throw new Error("prompt evidence refuses the live Cairn database");
  if (!existsSync(path)) throw new Error(`benchmark database not found: ${path}`);
  const db = new Database(path, { readonly: true });
  try {
    const table = db.query(`SELECT 1 AS ok FROM sqlite_master
      WHERE type='table' AND name='prompt_benchmark_meta'`).get();
    const marker = table ? db.query(`SELECT 1 AS ok FROM prompt_benchmark_meta
      WHERE isolated=1 LIMIT 1`).get() as { ok: number } | null : null;
    if (!marker) throw new Error("database is not marked as an isolated prompt benchmark");
    const benchmarkTables = db.query(`SELECT COUNT(*) AS count FROM sqlite_master
      WHERE type='table' AND name IN ('prompt_benchmark_runs','prompt_benchmark_events')`)
      .get() as { count: number };
    let events: ToolEvent[];
    let run: Record<string, number | string> | null;
    let unexpectedCount = 0;
    if (benchmarkTables.count === 2) {
      const rows = db.query(`SELECT tool_name,args_json,result_json
       FROM prompt_benchmark_events WHERE session_id=? ORDER BY seq`)
       .all(input.sessionId) as BenchmarkEventRow[];
      events = rows.map((row) => ({
       args: JSON.parse(row.args_json) as Record<string, unknown>,
       result: JSON.parse(row.result_json),
       name: normalizeToolName(row.tool_name),
       host: input.host,
      }));
      run = db.query(`SELECT prompt_tokens AS injected_tokens,completed,workflow_passed,
       tool_failures,stop_nudges,unexpected_events
       FROM prompt_benchmark_runs WHERE host=? AND session_id=?`)
       .get(input.host, input.sessionId) as Record<string, number | string> | null;
      unexpectedCount = Number(run?.unexpected_events || 0);
    } else {
      const rows = db.query(`SELECT tool_name,raw_json FROM host_events
       WHERE host=? AND session_id=? AND tool_name!=''
       ORDER BY recorded_ts,event_key`).all(input.host, input.sessionId) as HostRow[];
      events = rows.map((row) => payload(input.host, row.raw_json));
      run = db.query(`SELECT run_id,injected_tokens,completed,workflow_passed,
       tool_failures,stop_nudges FROM quality_runs
       WHERE host=? AND session_hash=? ORDER BY turn_seq DESC LIMIT 1`)
       .get(input.host, hashSession(input.sessionId)) as Record<string, number | string> | null;
      if (run) {
       const unexpected = db.query(`SELECT COUNT(*) AS count FROM quality_events
         WHERE run_id=? AND kind IN ('visibility_failure','deferred')`)
         .get(String(run.run_id)) as { count: number };
       unexpectedCount = unexpected.count;
      }
    }
    if (!run) throw new Error("no quality run found for isolated session");
    const shape = graphEvidence(events);
    const selectedSkillIds = events.flatMap((event) => {
      if (event.name === "skill_select" && Array.isArray(event.args.ids)) {
        return event.args.ids.filter((id): id is string => typeof id === "string");
      }
      if (event.name === "skill_create")       return resultIds(event.result);
      if (event.name === "skill") return [String(event.args.skill || "")].filter(Boolean);
      return [];
    });
    return {
      caseId: input.caseId,
      host: input.host,
      trial: input.trial,
      promptTokens: Number(run.injected_tokens),
      completed: Boolean(run.completed),
      workflowPassed: Boolean(run.workflow_passed),
      skillSelected: events.some((event) =>
        event.name === "skill" || event.name === "skill_select" || event.name === "skill_create"),
      selectedSkillIds: [...new Set(selectedSkillIds)],
      brainSearched: events.some((event) => event.name === "brain_search"),
      searchBeforeWrite: shape.searchBeforeWrite,
      rootCreated: Boolean(shape.root),
      rootSynthesized: shape.rootSynthesized,
      rootSynthesizedLast: shape.rootSynthesizedLast,
      createdNodes: shape.createdNodes,
      answeredNodes: shape.answeredNodes,
      citedAnswers: shape.citedAnswers,
      deepestLevel: shape.deepestLevel,
      returnedNodes: shape.returnedNodes,
      usedReturnedNodes: shape.usedReturnedNodes,
      taskAssertionSet: input.taskAssertionSet,
      taskAssertionsPassed: input.taskAssertionsPassed,
      taskAssertionsTotal: input.taskAssertionsTotal,
      toolFailures: Number(run.tool_failures),
      stopNudges: Number(run.stop_nudges),
      unexpectedEvents: unexpectedCount,
    };
  } finally {
    db.close();
  }
}
