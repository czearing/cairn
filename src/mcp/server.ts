import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { config } from "../core/config";
import { jsonChars, recordUsage } from "../core/usage";
import { neighborContext } from "./context";
import type { Neuron } from "../core/neurons.types";
import type { ScoredResult } from "../core/search.types";
import {
  recordBenchmarkTool,
  registerBenchmarkProcess,
  submitBenchmarkResult,
} from "../prompt-eval/benchmark-record";
import {
  appendBenchmarkReminder,
  benchmarkReminder,
} from "../prompt-eval/reminder-profile";

// The bridge that lets an agent read and write the brain. THREE tools, each a thin wrapper
// over src/core (the same code the tests cover). Run: bun src/mcp/server.ts
//
// Tool handlers resolve their logic through dynamic imports. Hosts that deliberately run this file with
// Bun hot reload can refresh handler behavior, while Copilot uses a stable stdio process because it starts
// the command without a Cairn project cwd. Tool names and schemas are session-scoped in either mode.

const server = new McpServer({ name: "cairn", version: "1.0.0" });
registerBenchmarkProcess();
const json = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data) }] });
const fail = (msg: string) => ({ content: [{ type: "text" as const, text: msg }], isError: true });
const measured = async <T>(
  toolName: string,
  input: unknown,
  run: () => Promise<T> | T,
): Promise<T> => {
  const started = performance.now();
  try {
    const result = await run();
    const delivered = appendBenchmarkReminder(result, benchmarkReminder(toolName, input));
    const durationMs = performance.now() - started;
    recordUsage({
      eventKind: "tool",
      source: "mcp",
      toolName,
      inputChars: jsonChars(input),
      outputChars: jsonChars(delivered),
      durationMs,
      success: !(result && typeof result === "object" && (result as { isError?: unknown }).isError === true),
    });
    recordBenchmarkTool({
      toolName,
      args: input,
      result,
      success: !(result && typeof result === "object" && (result as { isError?: unknown }).isError === true),
    });
    return delivered;
  } catch (error) {
    const durationMs = performance.now() - started;
    recordUsage({
      eventKind: "tool",
      source: "mcp",
      toolName,
      inputChars: jsonChars(input),
      durationMs,
      success: false,
    });
    recordBenchmarkTool({ toolName, args: input, result: null, success: false });
    throw error;
  }
};

// Attach a viewer deep-link so callers can show/cite the thought in the UI. Used on the single-node
// create/mutate returns, where the agent needs the url to report or link the node.
const withUrl = <T extends Neuron>(n: T) => ({ ...n, url: `${config.uiUrl}/node/${n.id}` });

// Lean agent-facing search hit. Keep the handle (`id`), the knowledge (`text`/`answer`/`citation`) and
// the relevance (`score`); DROP `edges` and `url`. `edges` is server-only graph data the agent cannot
// act on (no get-by-id tool), and the things that DO use it (the UI graph, optional subtree expansion)
// read it from core search()/the DB, not from this payload; `url` is derivable from `id`. Search returns
// many nodes, so trimming these two cuts a real slice off dense, hub-heavy result sets. The graph stays
// fully intact in the brain; it just no longer rides along in every result.
const leanHit = ({ id, text, answer, citation, score }: ScoredResult) => ({ id, text, answer, citation, score });

// Optional hard cap on the agent-facing result set, OFF by default (0): the breadth is controlled by
// the adaptive relevance floor in core search() (CAIRN_RELATIVE_FLOOR), a relevance bar rather than a
// count cap. Set CAIRN_SEARCH_LIMIT > 0 to also impose a top-N count cap as a backstop.
const SEARCH_LIMIT = Number(process.env.CAIRN_SEARCH_LIMIT || "0");

server.tool(
  "brain_search",
  "Returns the most relevant thoughts, ranked most-relevant-first (top matches only — refine the query for a different slice). Each result has a `score` (0-1 cosine relevance): weight high-scoring thoughts heavily and treat low-scoring ones as weak, tangential context. A result may also carry `prior`/`next`: the adjacent question above/below it in the brain's reasoning graph, for context. Use this as much as possible to learn from previous thoughts",
  { query: z.string().describe("What you are looking for, in natural language.") },
  async ({ query }) => measured("brain_search", { query }, async () => {
    const { search } = await import("../core/search");
    const { refsByIds } = await import("../core/neurons");
    // Relevance-ranked search (cosine, most-relevant-first).
    const hits = await search(query);
    const capped = SEARCH_LIMIT > 0 ? hits.slice(0, SEARCH_LIMIT) : hits;
    // Resolve each hit's adjacent decomposition questions (prior = parent, next = child) to short text:
    // a compact, useful use of edges (where a recalled thought sits in the reasoning flow) instead of
    // raw neighbor UUIDs the agent can't act on. One batched lookup for every referenced neighbor.
    const refs = refsByIds(capped.flatMap((h) => [h.id, ...h.edges]));
    const thoughts = capped.map((h) => ({ ...leanHit(h), ...neighborContext(h, refs) }));
    // The result set is kept tight by the adaptive relevance floor (CAIRN_RELATIVE_FLOOR, default 0.85 of the
    // top score) rather than a character cap — only genuinely-relevant thoughts qualify, so the payload stays
    // small without ever truncating a node's answer. Tighten the floor (or set CAIRN_SEARCH_LIMIT) to trim more.
    return json(thoughts);
  })
);

if (process.env.CAIRN_PROMPT_BENCHMARK_SESSION) {
  server.tool(
    "benchmark_submit",
    "Submit the exact final structured result for an isolated prompt benchmark.",
    { result: z.unknown().describe("The final structured result required by the benchmark task.") },
    async ({ result }) => measured("benchmark_submit", { result }, () =>
      json(submitBenchmarkResult(result)))
  );
}

server.tool(
  "brain_create",
  "Create a thought and return its id. Phrase it as an open question (what / how / why / which) — a yes/no question presumes its answer and cannot be split. Keep it concise, bloated text pollutes search. Link related thoughts by id so future agents can build on them",
  {
    text: z.string().describe("An open question starting with what / how / why / which. Never a yes/no question."),
    edges: z.array(z.string()).optional().describe("ids of related thoughts to link to."),
  },
  async ({ text, edges }) => measured("brain_create", { text, edges }, async () => {
    if (!text.trim()) return fail("text is required");
    const { create } = await import("../core/neurons");
    return json(withUrl(await create(text, edges ?? [])));
  })
);

server.tool(
  "brain_mutate",
  "Update an existing thought by id. Provide only the fields to change. Setting `answer` marks it solved. Returns the updated thought",
  {
    id: z.string().describe("id of the thought to update."),
    text: z.string().optional().describe("new question text."),
    answer: z.string().optional().describe("the solution; setting this marks it solved. Keep it concise and clear; an overlong answer is rejected, so split a sprawling one into child nodes instead."),
    citation: z
      .string()
      .optional()
      .describe("REQUIRED whenever you set a non-empty answer: the real source URL(s) you actually consulted. A thought with an answer but no citation is rejected"),
    edges: z.array(z.string()).optional().describe("the complete set of linked thought ids."),
  },
  async ({ id, text, answer, citation, edges }) => measured(
    "brain_mutate",
    { id, text, answer, citation, edges },
    async () => {
    try {
      const { mutate } = await import("../core/neurons");
      const n = await mutate(id, { text, answer, citation, edges });
      return n ? json(withUrl(n)) : fail(`no thought with id ${id}`);
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  })
);

server.tool(
  "brain_delete",
  "Delete a thought by id (removes it and detaches its edges from other thoughts). Use to clear duplicates or mistakes.",
  { id: z.string().describe("id of the thought to delete.") },
  async ({ id }) => measured("brain_delete", { id }, async () => {
    const { remove } = await import("../core/neurons");
    return json({ deleted: remove(id) });
  })
);

server.tool(
  "skill_select",
  "Before starting work, select every injected catalog skill you will use. Pass the exact injected catalog version so selection cannot race a catalog update. Returns exact reusable steps. Choose by title and usage description, never by wording similarity.",
  {
    ids: z.array(z.string()).min(1).max(4).describe("Exact skill ids from the auto-injected catalog."),
    catalogVersion: z.string().optional().describe("Exact Catalog version value from the injected catalog."),
  },
  async ({ ids, catalogVersion }) => measured("skill_select", { ids, catalogVersion }, async () => {
    const { skillSelect } = await import("../skill/hook");
    const result = skillSelect(ids, catalogVersion);
    return result.error ? fail(JSON.stringify(result)) : json(result);
  })
);

server.tool(
  "skill_search",
  "Legacy compatibility bridge. Current agents receive the catalog automatically and should call skill_select. Returns the catalog, or loads an exact id when task is `load:<id>`.",
  { task: z.string() },
  async ({ task }) => measured("skill_search", { task }, async () => {
    const { skillSearch } = await import("../skill/hook");
    return json(skillSearch(task));
  })
);

server.tool(
  "skill_create",
  "Create a broad reusable capability only after comparing the complete catalog. The description must state the distinct situations where it should be used; never create one for a user's mood, wording, one-off state, specific bug, handoff, wait, or response.",
  {
    title: z.string().describe("Broad capability title, 1-4 words."),
    description: z.string().describe("When this reusable capability should be used, including its method and boundaries."),
    plan: z.string().describe("Initial reusable master plan: numbered imperative steps only."),
    whyExistingSkillsDoNotFit: z.string().describe("Why none of the catalog entries covers this method."),
  },
  async ({ title, description, plan, whyExistingSkillsDoNotFit }) => measured(
    "skill_create",
    { title, description, plan, whyExistingSkillsDoNotFit },
    async () => {
    const { skillCreate } = await import("../skill/hook");
    const result = await skillCreate(title, description, plan, whyExistingSkillsDoNotFit);
    return result.error ? fail(result.error) : json(result);
  })
);

// Agent-facing DIRECT refinement. Lets the agent fix a skill's master the moment it learns a better way —
// classically, the user says "that was wrong, do X next time" — so the correction lands in the master
// immediately and the very next run uses it.
server.tool(
  "skill_edit",
  "Refine a selected or created skill's master prompt directly when the user corrects the method. Pass its exact id and numbered imperative steps.",
  {
    id: z.string().describe("The exact selected or created skill id."),
    master: z.string().describe("The rewritten master: numbered imperative steps only, no rationale/preamble."),
    explanation: z.string().optional().describe("Optional maintenance note explaining why the revised method is better."),
  },
  async ({ id, master, explanation }) => measured("skill_edit", { id, master, explanation }, async () => {
    const { skillEdit } = await import("../skill/hook");
    const r = await skillEdit(id, master, explanation);
    return r.ok ? json(r) : fail(r.error || "skill_edit failed");
  })
);

// Bind the stdio transport exactly once. This guard also keeps optional hot-reload hosts from binding a
// second listener to the same stdin.
const hotState = globalThis as typeof globalThis & { __cairnConnected?: boolean };
if (!hotState.__cairnConnected) {
  hotState.__cairnConnected = true;
  await server.connect(new StdioServerTransport());
}
