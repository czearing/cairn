import {
  McpServer,
  type RegisteredTool,
  type ToolCallback,
} from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readFileSync } from "node:fs";
import { AsyncLocalStorage } from "node:async_hooks";
import { config } from "../core/config";
import { jsonChars, recordTelemetry } from "../core/telemetry";
import { structuredResult } from "../core/telemetry-entities";
import {
  promptFingerprint,
  releaseFingerprint,
  releaseVersion,
  telemetryRunClass,
} from "../core/release";
import { installedReleaseVersion, runtimeMetadata } from "../core/runtime-identity";
import { formatSkillCatalog, skillCatalogSnapshot } from "../skill/catalog";
import type { Neuron } from "../core/neurons.types";
import { searchPayload } from "./search-payload";
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
// Bun hot reload re-evaluates this module while the connected server remains on globalThis. Each pass
// refreshes callbacks and schemas in place, so existing host sessions receive new behavior without
// replacing their stdio connection.

interface HotState {
  server?: McpServer;
  connected?: boolean;
  tools?: Map<string, RegisteredTool>;
}
const hotState = globalThis as typeof globalThis & { __cairnHotState?: HotState };
const state = hotState.__cairnHotState ??= {};
const server = state.server ??= new McpServer({ name: "cairn", version: "1.0.0" });
const registeredTools = state.tools ??= new Map<string, RegisteredTool>();
const registerTool = <Args extends z.ZodRawShape>(
  name: string,
  description: string,
  schema: Args,
  callback: ToolCallback<Args>,
): void => {
  const registered = registeredTools.get(name);
  if (registered) {
    registered.update({ description, paramsSchema: schema, callback });
    return;
  }
  registeredTools.set(name, server.tool(name, description, schema, callback));
};
registerBenchmarkProcess();
const currentReleaseIdentity = () => {
  const version = installedReleaseVersion(releaseVersion);
  try {
    const prompt = readFileSync(new URL("../../prompts/user-message.md", import.meta.url), "utf8").trim();
    const catalog = skillCatalogSnapshot();
    const fullPrompt = `${prompt}\n\n${formatSkillCatalog()}`;
    return {
      releaseFingerprint: releaseFingerprint(promptFingerprint(fullPrompt), catalog.version, version),
      version,
      runClass: telemetryRunClass(),
    };
  } catch {
    return {
      releaseFingerprint: version,
      version,
      runClass: telemetryRunClass(),
    };
  }
};
type ReleaseIdentity = ReturnType<typeof currentReleaseIdentity>;
const releaseIdentityContext = new AsyncLocalStorage<ReleaseIdentity>();
const activeReleaseIdentity = () => releaseIdentityContext.getStore() ?? currentReleaseIdentity();
const json = (data: unknown) => ({
  _meta: runtimeMetadata({ ...activeReleaseIdentity(), pid: process.pid }),
  content: [{ type: "text" as const, text: JSON.stringify(data) }],
});
const fail = (msg: string) => ({
  _meta: runtimeMetadata({ ...activeReleaseIdentity(), pid: process.pid }),
  content: [{ type: "text" as const, text: msg }],
  isError: true,
});
const measured = async <T>(
  toolName: string,
  input: unknown,
  run: () => Promise<T> | T,
): Promise<T> => {
  const started = performance.now();
  const identity = currentReleaseIdentity();
  return releaseIdentityContext.run(identity, async () => {
    try {
      const result = await run();
      const delivered = appendBenchmarkReminder(result, benchmarkReminder(toolName, input));
      const durationMs = performance.now() - started;
      recordTelemetry({
        kind: "tool_transport",
        source: "mcp",
        toolName,
        inputChars: jsonChars(input),
        outputChars: jsonChars(structuredResult(delivered)),
        durationMs,
        success: !(result && typeof result === "object" && (result as { isError?: unknown }).isError === true),
        ...identity,
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
      recordTelemetry({
        kind: "tool_transport",
        source: "mcp",
        toolName,
        inputChars: jsonChars(input),
        durationMs,
        success: false,
        ...identity,
      });
      recordBenchmarkTool({ toolName, args: input, result: null, success: false });
      throw error;
    }
  });
};

// Attach a viewer deep-link so callers can show/cite the thought in the UI.
const nodeUrl = (id: string): string => `${config.uiUrl}/node/${id}`;
const mutationAck = ({ id }: Neuron) => ({ id, url: nodeUrl(id) });
const skillSelectionAck = (result: {
  selected: { id: string; steps: string }[];
  catalogVersion: string;
}) => ({
  selected: result.selected.map(({ id, steps }) => ({ id, steps })),
  catalogVersion: result.catalogVersion,
});

// Optional hard cap on the agent-facing result set, OFF by default (0): the breadth is controlled by
// the adaptive relevance floor in core search() (CAIRN_RELATIVE_FLOOR), a relevance bar rather than a
// count cap. Set CAIRN_SEARCH_LIMIT > 0 to also impose a top-N count cap as a backstop.
const SEARCH_LIMIT = Number(process.env.CAIRN_SEARCH_LIMIT || "0");

registerTool(
  "brain_search",
  "Returns the most relevant thoughts, ranked most-relevant-first (top matches only — refine the query for a different slice). Each result has a bounded `score` (0-1) combining semantic relevance with a small boost for links to other relevant results. Weight high-scoring thoughts heavily and treat low-scoring ones as weak, tangential context. A result may also carry `prior`/`next`: the adjacent question above/below it in the brain's reasoning graph, for context. Use this as much as possible to learn from previous thoughts",
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
    const thoughts = searchPayload(capped, refs);
    // The result set is kept tight by the adaptive relevance floor (CAIRN_RELATIVE_FLOOR, default 0.85 of the
    // top score) rather than a character cap — only genuinely-relevant thoughts qualify, so the payload stays
    // small without ever truncating a node's answer. Tighten the floor (or set CAIRN_SEARCH_LIMIT) to trim more.
    return json(thoughts);
  })
);

if (process.env.CAIRN_PROMPT_BENCHMARK_SESSION) {
  registerTool(
    "benchmark_submit",
    "Submit the exact final structured result for an isolated prompt benchmark.",
    { result: z.unknown().describe("The final structured result required by the benchmark task.") },
    async ({ result }) => measured("benchmark_submit", { result }, () =>
      json(submitBenchmarkResult(result)))
  );
}

registerTool(
  "brain_create",
  "Create a thought and return its id and viewer URL. Phrase it as an open question (what / how / why / which) — a yes/no question presumes its answer and cannot be split. Keep it concise, bloated text pollutes search. Link related thoughts by id so future agents can build on them",
  {
    text: z.string().describe("An open question starting with what / how / why / which. Never a yes/no question."),
    edges: z.array(z.string()).optional().describe("ids of related thoughts to link to."),
  },
  async ({ text, edges }) => measured("brain_create", { text, edges }, async () => {
    if (!text.trim()) return fail("text is required");
    const { create } = await import("../core/neurons");
    return json(mutationAck(await create(text, edges ?? [])));
  })
);

registerTool(
  "brain_mutate",
  "Update an existing thought by id. Provide only the fields to change. Setting `answer` marks it solved. Returns its id and viewer URL",
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
      return n ? json(mutationAck(n)) : fail(`no thought with id ${id}`);
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  })
);

registerTool(
  "brain_delete",
  "Delete a thought by id (removes it and detaches its edges from other thoughts). Use to clear duplicates or mistakes.",
  { id: z.string().describe("id of the thought to delete.") },
  async ({ id }) => measured("brain_delete", { id }, async () => {
    const { remove } = await import("../core/neurons");
    return json({ deleted: remove(id) });
  })
);

registerTool(
  "skill_select",
  "Before starting work, select every injected catalog skill you will use. Pass the exact injected catalog version so selection cannot race a catalog update. Returns exact reusable steps. Choose by title and usage description, never by wording similarity.",
  {
    ids: z.array(z.string()).min(1).max(4).describe("Exact skill ids from the auto-injected catalog."),
    catalogVersion: z.string().optional().describe("Exact Catalog version value from the injected catalog."),
  },
  async ({ ids, catalogVersion }) => measured("skill_select", { ids, catalogVersion }, async () => {
    const { skillSelect } = await import("../skill/hook");
    const result = skillSelect(ids, catalogVersion);
    return result.error ? fail(JSON.stringify(result)) : json(skillSelectionAck(result));
  })
);

registerTool(
  "skill_search",
  "Legacy compatibility bridge. Current agents receive the catalog automatically and should call skill_select. Returns the catalog, or loads an exact id when task is `load:<id>`.",
  { task: z.string() },
  async ({ task }) => measured("skill_search", { task }, async () => {
    const { skillSearch } = await import("../skill/hook");
    return json(skillSearch(task));
  })
);

registerTool(
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
registerTool(
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
if (!state.connected) {
  state.connected = true;
  await server.connect(new StdioServerTransport());
} else {
  // RegisteredTool.update() emits tools/list_changed for each refreshed definition.
}
