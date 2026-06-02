import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { create, mutate } from "../core/neurons";
import { search } from "../core/search";

// The bridge that lets an agent read and write the brain. THREE tools, each a thin wrapper
// over src/core (the same code the tests cover). Run: bun src/mcp/server.ts

const server = new McpServer({ name: "cairn", version: "1.0.0" });
const json = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data) }] });
const fail = (msg: string) => ({ content: [{ type: "text" as const, text: msg }], isError: true });

server.tool(
  "brain_search",
  "Semantic search the brain. Returns every relevant neuron ranked most-relevant-first, plus the whole connected subgraph of each hit. No limit. Use this FIRST to find existing thinking.",
  { query: z.string().describe("What you are looking for, in natural language.") },
  async ({ query }) => json(await search(query))
);

server.tool(
  "brain_create",
  "Create a new neuron (a question/problem note). Returns it with its id. Optionally link it to existing neurons by id.",
  {
    text: z.string().describe("The question or problem, in natural language."),
    edges: z.array(z.string()).optional().describe("ids of related neurons to link to."),
  },
  async ({ text, edges }) => (text.trim() ? json(await create(text, edges ?? [])) : fail("text is required"))
);

server.tool(
  "brain_mutate",
  "Update an existing neuron by id. Provide only the fields to change. Setting `answer` marks it solved. Returns the updated neuron.",
  {
    id: z.string().describe("id of the neuron to update."),
    text: z.string().optional().describe("new question text."),
    answer: z.string().optional().describe("the solution; setting this marks it solved."),
    edges: z.array(z.string()).optional().describe("the complete set of linked neuron ids."),
  },
  async ({ id, text, answer, edges }) => {
    const n = await mutate(id, { text, answer, edges });
    return n ? json(n) : fail(`no neuron with id ${id}`);
  }
);

await server.connect(new StdioServerTransport());
