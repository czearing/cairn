import {
  McpServer,
  type RegisteredTool,
  type ToolCallback,
} from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { config } from "../core/config";
import { installCrashGuard } from "../core/crash-guard";
import { recordTelemetry } from "../core/telemetry-record";
import { jsonChars } from "../core/telemetry-size";
import { structuredResult } from "../core/telemetry-entities";
import {
  promptFingerprint,
  releaseFingerprint,
  releaseVersion,
  telemetryRunClass,
} from "../core/release";
import { installedReleaseVersion, runtimeMetadata } from "../core/runtime-identity";
import { warmEngineServer } from "../core/engine-client";
import { claimWriterRole } from "../core/writer-role";
import type { Neuron } from "../core/neurons.types";
import { searchPayload } from "./search-payload";

// The bridge that lets an agent read and write the brain. THREE tools, each a thin wrapper
// over src/core (the same code the tests cover). Run: bun src/mcp/server.ts
//
// Bun hot reload re-evaluates this module while the connected server remains on globalThis. Each pass
// refreshes callbacks and schemas in place, so existing host sessions receive new behavior without
// replacing their stdio connection.

// A stray async fault anywhere in this process would otherwise terminate it, and the host would
// report only "Connection closed" with nothing to diagnose. Install the guard before any async work
// starts. See core/crash-guard.ts.
installCrashGuard("mcp-server");

// The MCP surface is the agent's WRITE path (brain_create/mutate/delete). Whatever launched this
// process — a host CLI started from a shell that exported the flag, or any Cairn reader — must not be
// able to demote it to a read-only brain connection. See core/writer-role.ts.
const inheritedReaderRole = claimWriterRole();
if (inheritedReaderRole) {
  // stderr, never stdout: stdout is the MCP protocol channel.
  console.error("cairn: cleared an inherited CAIRN_READONLY=1 role; brain writes are enabled.");
}

interface HotState {
  server?: McpServer;
  connected?: boolean;
  tools?: Map<string, RegisteredTool>;
  toolSchemas?: Map<string, { chars: number; fingerprint: string }>;
  idleGc?: ReturnType<typeof setTimeout>;
  orphanWatchdog?: ReturnType<typeof setInterval>;
}

// Same probe as core/engine-client.ts's pidAlive: signal 0 sends nothing but still surfaces ESRCH
// (no such process) vs EPERM (exists, just not ours to signal) vs success (exists).
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as { code?: string })?.code === "EPERM";
  }
}

// Belt-and-suspenders for exitWithHost below: stdin 'end'/'close' depends on the host cleanly
// closing its end of the pipe, and proved unreliable in practice (orphaned bun processes were
// found running minutes after their launching host process had already exited, with neither event
// ever firing). Poll the actual parent PID instead so a genuinely dead host is always caught, even
// when the pipe-close signal never arrives.
function startOrphanWatchdog() {
  const parentPid = process.ppid;
  if (!parentPid) return;
  state.orphanWatchdog ??= setInterval(() => {
    if (!pidAlive(parentPid)) process.exit(0);
  }, 15_000).unref();
}
const hotState = globalThis as typeof globalThis & { __cairnHotState?: HotState };
const state = hotState.__cairnHotState ??= {};
const server = state.server ??= new McpServer({ name: "cairn", version: "1.0.0" });
const registeredTools = state.tools ??= new Map<string, RegisteredTool>();
const toolSchemas = state.toolSchemas ??= new Map<string, { chars: number; fingerprint: string }>();
const scheduleIdleGc = (): void => {
  if (state.idleGc) clearTimeout(state.idleGc);
  state.idleGc = setTimeout(() => {
    Bun.gc(true);
    state.idleGc = undefined;
  }, Number(process.env.CAIRN_MCP_IDLE_GC_MS || "1000"));
  state.idleGc.unref();
};
const benchmark = process.env.CAIRN_PROMPT_BENCHMARK_SESSION
  ? {
      ...await import("../prompt-eval/benchmark-record"),
      ...await import("../prompt-eval/reminder-profile"),
    }
  : null;
const registerTool = <Args extends z.ZodRawShape>(
  name: string,
  description: string,
  schema: Args,
  callback: ToolCallback<Args>,
): void => {
  const definition = JSON.stringify({
    name,
    description,
    inputSchema: z.toJSONSchema(z.object(schema)),
  });
  toolSchemas.set(name, {
    chars: definition.length,
    fingerprint: promptFingerprint(definition),
  });
  const registered = registeredTools.get(name);
  if (registered) {
    registered.update({ description, paramsSchema: schema, callback });
    return;
  }
  registeredTools.set(name, server.tool(name, description, schema, callback));
};
benchmark?.registerBenchmarkProcess();
const warmSearch = async (): Promise<void> => {
  try {
    const { warmSearchEngine } = await import("../core/search");
    await warmSearchEngine();
  } catch (error) {
    console.error(`[cairn] search warmup failed: ${error instanceof Error ? error.message : String(error)}`);
  }
};
const warmEngine = async (): Promise<void> => {
  try {
    if (await warmEngineServer()) return;
  } catch (error) {
    console.error(`[cairn] engine warmup failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  await warmSearch();
};
const currentReleaseIdentity = () => {
  const version = installedReleaseVersion(releaseVersion);
  try {
    const root = process.env.CAIRN_ROOT || resolve(import.meta.dir, "..", "..");
    const prompt = readFileSync(join(root, "prompts", "user-message.md"), "utf8");
    return {
      releaseFingerprint: releaseFingerprint(promptFingerprint(prompt), "local", version),
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
      const delivered = benchmark
        ? benchmark.appendBenchmarkReminder(result, benchmark.benchmarkReminder(toolName, input))
        : result;
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
      benchmark?.recordBenchmarkTool({
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
      benchmark?.recordBenchmarkTool({ toolName, args: input, result: null, success: false });
      throw error;
    } finally {
      scheduleIdleGc();
    }
  });
};

// Attach a viewer deep-link so callers can show/cite the thought in the UI.
const nodeUrl = (id: string): string => `${config.uiUrl}/node/${id}`;
const mutationAck = ({ id }: Neuron) => ({ id, url: nodeUrl(id) });

// Optional hard cap on the agent-facing result set, OFF by default (0): the breadth is controlled by
// the adaptive relevance floor in core search() (CAIRN_RELATIVE_FLOOR), a relevance bar rather than a
// count cap. Set CAIRN_SEARCH_LIMIT > 0 to also impose a top-N count cap as a backstop.
const SEARCH_LIMIT = Number(process.env.CAIRN_SEARCH_LIMIT || "0");

registerTool(
  "brain_search",
  "Search thoughts by semantic relevance. Results are score-ordered and may include adjacent `prior`/`next` question context.",
  { query: z.string().describe("What you are looking for, in natural language.") },
  async ({ query }) => measured("brain_search", { query }, async () => {
    try {
      const { engineSearch } = await import("../core/engine-client");
      const { refsByIds } = await import("../core/neurons");
      // Relevance-ranked search (cosine, most-relevant-first).
      const hits = await engineSearch(query, activeReleaseIdentity());
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
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  })
);

if (benchmark) {
  registerTool(
    "benchmark_submit",
    "Submit the exact final structured result for an isolated prompt benchmark.",
    { result: z.unknown().describe("The final structured result required by the benchmark task.") },
    async ({ result }) => measured("benchmark_submit", { result }, () => {
      try {
        return json(benchmark.submitBenchmarkResult(result));
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    })
  );
}

registerTool(
  "brain_create",
  "Create a thought and return its id and viewer URL. Any near-duplicate candidates are advisory; creation always succeeds independently.",
  {
    text: z.string().describe("An open question starting with what / how / why / which. Never a yes/no question."),
    edges: z.array(z.string()).optional().describe("ids of related thoughts to link to."),
  },
  async ({ text, edges }) => measured("brain_create", { text, edges }, async () => {
    if (!text.trim()) return fail("text is required");
    try {
      const { engineCreate } = await import("../core/engine-client");
      const { neuron, nearDuplicates } = await engineCreate(
        text,
        edges ?? [],
        activeReleaseIdentity(),
      );
      return json({
        ...mutationAck(neuron),
        ...(nearDuplicates.length ? { nearDuplicates } : {}),
      });
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  })
);

registerTool(
  "brain_mutate",
  "Update an existing thought by id and return its id and viewer URL.",
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
      const { engineMutate } = await import("../core/engine-client");
      const n = await engineMutate(
        id,
        { text, answer, citation, edges },
        activeReleaseIdentity(),
      );
      return n ? json(mutationAck(n)) : fail(`no thought with id ${id}`);
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  })
);

registerTool(
  "brain_delete",
  "Delete a thought by id and detach its graph edges.",
  { id: z.string().describe("id of the thought to delete.") },
  async ({ id }) => measured("brain_delete", { id }, async () => {
    try {
      const { engineDelete } = await import("../core/engine-client");
      return json({ deleted: await engineDelete(id, activeReleaseIdentity()) });
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  })
);

// The proof contract is always registered. Gating tool REGISTRATION on the same env flag that gates the
// deny created a hard dependency ordering: with the gate on but the tool absent, pre-tool denies every
// execution tool while the agent has no way to declare a contract, locking the session. Registering it
// unconditionally makes the tool's presence independent of whether the gate is currently enforcing.
registerTool(
  "plan",
  "Declare and manage the task plan / todo checklist. Define what done means with actionable tasks, append new items as you discover work, and mark items completed with evidence.",
  {
    tasks: z.array(z.string()).min(1).optional()
      .describe("List of planned tasks/todo items defining done. Append anytime."),
    checks: z.array(z.string()).min(1).optional()
      .describe("Alias for tasks."),
    completed: z.string().optional().describe("A planned task/todo item to mark as done."),
    satisfied: z.string().optional().describe("Alias for completed."),
    evidence: z.string().optional().describe("What satisfies it: the artifact produced, test command run, or observed output."),
  },
  async ({ tasks, checks, completed, satisfied, evidence }) => measured("plan", { tasks, checks, completed, satisfied, evidence }, async () => {
    const itemToClose = completed || satisfied;
    const itemsToAdd = tasks || checks;
    if (itemToClose && !evidence?.trim()) return fail("evidence is required: describe what satisfies this task");
    if (!itemToClose && !(itemsToAdd?.some((item) => item.trim()))) {
      return fail("provide at least one planned task item");
    }
    return json({ accepted: true });
  })
);

registerTool(
  "contract",
  "Alias for plan. Declare what done means for this task and close criteria with evidence.",
  {
    checks: z.array(z.string()).min(1).optional()
      .describe("Declare the criteria that define done."),
    tasks: z.array(z.string()).min(1).optional()
      .describe("Alias for checks."),
    satisfied: z.string().optional().describe("A declared criterion to close."),
    completed: z.string().optional().describe("Alias for satisfied."),
    evidence: z.string().optional().describe("What satisfies it: the artifact produced or the output observed."),
  },
  async ({ checks, tasks, satisfied, completed, evidence }) => measured("contract", { checks, tasks, satisfied, completed, evidence }, async () => {
    const itemToClose = satisfied || completed;
    const itemsToAdd = checks || tasks;
    if (itemToClose && !evidence?.trim()) return fail("evidence is required: name the artifact that satisfies this");
    if (!itemToClose && !(itemsToAdd?.some((check) => check.trim()))) {
      return fail("declare at least one criterion describing what done means");
    }
    return json({ accepted: true });
  })
);

const schemaIdentity = currentReleaseIdentity();
for (const [toolName, schema] of toolSchemas) {
  recordTelemetry({
    kind: "tool_schema",
    source: "mcp",
    toolName,
    contextChars: schema.chars,
    itemCount: 1,
    eventKey: `tool-schema:${schemaIdentity.releaseFingerprint}:${toolName}:${schema.fingerprint}`,
    ...schemaIdentity,
  });
}

// Bind the stdio transport exactly once. This guard also keeps optional hot-reload hosts from binding a
// second listener to the same stdin.
if (!state.connected) {
  await warmEngine();
  state.connected = true;
  await server.connect(new StdioServerTransport());
  // StdioServerTransport only listens for stdin 'data'/'error' (see the SDK's server/stdio.js), never
  // 'end'/'close'. When the host process (e.g. an ACP agent) exits, its end of the pipe closes and
  // stdin reaches EOF here, but nothing reacts to that — so this process would otherwise run forever,
  // orphaned. Exit as soon as the host disconnects so it never outlives its parent.
  const exitWithHost = () => process.exit(0);
  process.stdin.once("end", exitWithHost);
  process.stdin.once("close", exitWithHost);
  startOrphanWatchdog();
} else {
  void warmEngine();
  // RegisteredTool.update() emits tools/list_changed for each refreshed definition.
}
