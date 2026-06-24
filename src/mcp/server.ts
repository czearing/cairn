import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { create, mutate, remove, refsByIds } from "../core/neurons";
import { isClosedQuestion } from "../core/audit";
import { search } from "../core/search";
import { config } from "../core/config";
import { fitToBudget } from "./budget";
import { neighborContext } from "./context";
import type { Neuron } from "../core/neurons.types";
import type { ScoredResult } from "../core/search.types";

// The bridge that lets an agent read and write the brain. THREE tools, each a thin wrapper
// over src/core (the same code the tests cover). Run: bun src/mcp/server.ts

const server = new McpServer({ name: "cairn", version: "1.0.0" });
const json = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data) }] });
const fail = (msg: string) => ({ content: [{ type: "text" as const, text: msg }], isError: true });

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

// Character budget for the serialized result. NOT a result-count cap: results are filled most-relevant
// -first until this budget is spent (see fitToBudget). Calibrated from real overflows: agent-facing
// brain_search results of 66k and 140k chars both exceeded the host's tool-output token ceiling (~25k
// tokens; dense JSON tokenizes near ~2.5 chars/token, so ~62k chars is the failing edge). 50k leaves
// real headroom under that. Set CAIRN_SEARCH_BUDGET to retune, or 0 to disable.
const SEARCH_BUDGET = Number(process.env.CAIRN_SEARCH_BUDGET ?? "50000");

server.tool(
  "brain_search",
  "Returns the most relevant thoughts, ranked most-relevant-first (top matches only — refine the query for a different slice). Each result has a `score` (0-1 cosine relevance): weight high-scoring thoughts heavily and treat low-scoring ones as weak, tangential context. A result may also carry `prior`/`next`: the adjacent question above/below it in the brain's reasoning graph, for context. Use this as much as possible to learn from previous thoughts",
  { query: z.string().describe("What you are looking for, in natural language.") },
  async ({ query }) => {
    // Relevance-ranked search (cosine, most-relevant-first).
    const hits = await search(query);
    const capped = SEARCH_LIMIT > 0 ? hits.slice(0, SEARCH_LIMIT) : hits;
    // Resolve each hit's adjacent decomposition questions (prior = parent, next = child) to short text:
    // a compact, useful use of edges (where a recalled thought sits in the reasoning flow) instead of
    // raw neighbor UUIDs the agent can't act on. One batched lookup for every referenced neighbor.
    const refs = refsByIds(capped.flatMap((h) => [h.id, ...h.edges]));
    const withCtx = capped.map((h) => ({ ...leanHit(h), ...neighborContext(h, refs) }));
    // Then fit the ranked hits into the output budget (most-relevant-first) so a large result never
    // overflows the transport and fails the whole call.
    return json(fitToBudget(withCtx, SEARCH_BUDGET));
  }
);

server.tool(
  "brain_create",
  "Create a thought and return its id. The text MUST be an open question (what / how / why / which); yes/no questions are rejected. Keep it concise, bloated text pollutes search. Link related thoughts by id so future agents can build on them",
  {
    text: z.string().describe("An open question starting with what / how / why / which. Never a yes/no question."),
    edges: z.array(z.string()).optional().describe("ids of related thoughts to link to."),
  },
  async ({ text, edges }) => {
    if (!text.trim()) return fail("text is required");
    if (isClosedQuestion(text)) return fail("Rejected: that is a yes/no question and presumes its answer. Re-ask it as a how or why question, then create it.");
    return json(withUrl(await create(text, edges ?? [])));
  }
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
  async ({ id, text, answer, citation, edges }) => {
    try {
      const n = await mutate(id, { text, answer, citation, edges });
      return n ? json(withUrl(n)) : fail(`no thought with id ${id}`);
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  }
);

server.tool(
  "brain_delete",
  "Delete a thought by id (removes it and detaches its edges from other thoughts). Use to clear duplicates or mistakes.",
  { id: z.string().describe("id of the thought to delete.") },
  async ({ id }) => json({ deleted: remove(id) })
);

await server.connect(new StdioServerTransport());
