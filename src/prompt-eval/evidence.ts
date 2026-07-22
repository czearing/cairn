import { createHash } from "node:crypto";
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { PromptHost, PromptRunEvidence } from "./types";

interface HostRow {
  tool_name: string;
  raw_json: string;
}

const liveDb = resolve(join(homedir(), ".cairn", "cairn.db"));
const hashSession = (value: string) =>
  createHash("sha256").update(value).digest("hex").slice(0, 16);
const toolName = (value: string) =>
  value.toLowerCase().replace(/^.*(?:__|-)(?=(?:brain|skill)_)/, "");

function structured(value: unknown): unknown {
  if (typeof value === "string") {
    try { return structured(JSON.parse(value)); } catch { return value; }
  }
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(structured);
  const row = value as Record<string, unknown>;
  if (typeof row.id === "string") return row;
  for (const key of ["textResultForLlm", "toolResult", "result"]) {
    if (row[key] != null) return structured(row[key]);
  }
  if (Array.isArray(row.content)) {
    return structured(row.content.length === 1 ? row.content[0] : row.content);
  }
  if (typeof row.text === "string") return structured(row.text);
  return row;
}

function ids(value: unknown): string[] {
  const parsed = structured(value);
  if (Array.isArray(parsed)) return parsed.flatMap(ids);
  if (!parsed || typeof parsed !== "object") return [];
  const id = (parsed as Record<string, unknown>).id;
  return typeof id === "string" && id ? [id] : [];
}

function payload(host: PromptHost, raw: string) {
  const row = JSON.parse(raw) as Record<string, unknown>;
  const args = (row.toolArgs ?? row.tool_input ?? {}) as Record<string, unknown>;
  const result = row.toolResult ?? row.tool_result ?? row.toolOutput ?? row.tool_output;
  return {
    args: typeof args === "object" && args ? args : {},
    result,
    name: toolName(String(row.toolName ?? row.tool_name ?? "")),
    host,
  };
}

function graph(events: ReturnType<typeof payload>[]) {
  const created: string[] = [];
  const depths = new Map<string, number>();
  const answered = new Set<string>();
  const cited = new Set<string>();
  const returned = new Set<string>();
  const used = new Set<string>();
  let searchedAt = -1;
  let firstWriteAt = -1;
  let lastAnswerId = "";
  for (const [index, event] of events.entries()) {
    if (event.name === "brain_search") {
      if (searchedAt < 0) searchedAt = index;
      for (const id of ids(event.result)) returned.add(id);
    }
    if (event.name === "brain_create") {
      if (firstWriteAt < 0) firstWriteAt = index;
      const id = ids(event.result)[0];
      if (!id) continue;
      created.push(id);
      const edges = Array.isArray(event.args.edges) ? event.args.edges as string[] : [];
      for (const edge of edges) used.add(edge);
      const parentDepths = edges.map((edge) => depths.get(edge)).filter((v): v is number => v != null);
      depths.set(id, parentDepths.length ? Math.max(...parentDepths) + 1 : 0);
    }
    if (event.name === "brain_mutate") {
      if (firstWriteAt < 0) firstWriteAt = index;
      const id = String(event.args.id || "");
      if (id) used.add(id);
      if (id && typeof event.args.answer === "string" && event.args.answer.trim()) {
        answered.add(id);
        lastAnswerId = id;
      }
      if (id && typeof event.args.citation === "string" && event.args.citation.trim()) cited.add(id);
    }
  }
  const root = created[0] || "";
  return {
    root,
    createdNodes: created.length,
    answeredNodes: created.filter((id) => answered.has(id)).length,
    citedAnswers: created.filter((id) => cited.has(id)).length,
    maxDepth: Math.max(0, ...depths.values()),
    returnedNodes: returned.size,
    usedReturnedNodes: [...returned].filter((id) => used.has(id)).length,
    rootSynthesized: Boolean(root && answered.has(root)),
    rootSynthesizedLast: Boolean(root && lastAnswerId === root),
    searchBeforeWrite: searchedAt >= 0 && (firstWriteAt < 0 || searchedAt < firstWriteAt),
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
    const rows = db.query(`SELECT tool_name,raw_json FROM host_events
      WHERE host=? AND session_id=? AND tool_name!=''
      ORDER BY recorded_ts,event_key`).all(input.host, input.sessionId) as HostRow[];
    const events = rows.map((row) => payload(input.host, row.raw_json));
    const run = db.query(`SELECT run_id,injected_tokens,completed,workflow_passed,
      tool_failures,stop_nudges FROM quality_runs
      WHERE host=? AND session_hash=? ORDER BY turn_seq DESC LIMIT 1`)
      .get(input.host, hashSession(input.sessionId)) as Record<string, number | string> | null;
    if (!run) throw new Error("no quality run found for isolated session");
    const unexpected = db.query(`SELECT COUNT(*) AS count FROM quality_events
      WHERE run_id=? AND kind IN ('visibility_failure','deferred')`)
      .get(String(run.run_id)) as { count: number };
    const shape = graph(events);
    const selectedSkillIds = events.flatMap((event) => {
      if (event.name === "skill_select" && Array.isArray(event.args.ids)) {
        return event.args.ids.filter((id): id is string => typeof id === "string");
      }
      if (event.name === "skill_create") return ids(event.result);
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
      maxDepth: shape.maxDepth,
      returnedNodes: shape.returnedNodes,
      usedReturnedNodes: shape.usedReturnedNodes,
      taskAssertionSet: input.taskAssertionSet,
      taskAssertionsPassed: input.taskAssertionsPassed,
      taskAssertionsTotal: input.taskAssertionsTotal,
      toolFailures: Number(run.tool_failures),
      stopNudges: Number(run.stop_nudges),
      unexpectedEvents: unexpected.count,
    };
  } finally {
    db.close();
  }
}
