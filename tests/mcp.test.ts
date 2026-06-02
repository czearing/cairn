// End-to-end: spawn the real server over stdio and drive it with an MCP client, exactly how
// an agent talks to it. Proves the three tools work against the real core.
import { test, expect, beforeAll, afterAll } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const TEST_DB = join(tmpdir(), `cairn-mcp-${randomUUID()}.db`);
let client: Client;

beforeAll(async () => {
  const transport = new StdioClientTransport({
    command: "bun",
    args: ["src/mcp/server.ts"],
    env: { ...process.env, CAIRN_DB_PATH: TEST_DB },
  });
  client = new Client({ name: "cairn-test", version: "1.0.0" });
  await client.connect(transport);
});
afterAll(async () => client.close());

const call = (name: string, args: Record<string, unknown>) =>
  client.callTool({ name, arguments: args }) as Promise<{
    isError?: boolean;
    content: { text: string }[];
  }>;
const parse = (r: { content: { text: string }[] }) => JSON.parse(r.content[0]!.text);

test("exposes exactly the three brain tools", async () => {
  const { tools } = await client.listTools();
  expect(tools.map((t) => t.name).sort()).toEqual(["brain_create", "brain_mutate", "brain_search"]);
});

test("brain_create returns a neuron with an id and a viewer url", async () => {
  const n = parse(await call("brain_create", { text: "How do I write a haiku poem?" }));
  expect(n.id).toBeTruthy();
  expect(n.answer).toBe("");
  expect(n.url).toContain(`/node/${n.id}`);
});

test("brain_create rejects empty text", async () => {
  expect((await call("brain_create", { text: "   " })).isError).toBe(true);
});

test("brain_search finds a neuron by meaning", async () => {
  await call("brain_create", { text: "How do I write a haiku poem?" });
  const results = parse(await call("brain_search", { query: "compose some verse" }));
  expect(results.some((r: { text: string }) => r.text.includes("haiku"))).toBe(true);
});

test("brain_mutate sets an answer + citation and it is findable by it", async () => {
  const n = parse(await call("brain_create", { text: "A geography question" }));
  const updated = parse(await call("brain_mutate", {
    id: n.id,
    answer: "The capital of France is Paris.",
    citation: "https://en.wikipedia.org/wiki/Paris",
  }));
  expect(updated.answer).toBe("The capital of France is Paris.");
  expect(updated.citation).toBe("https://en.wikipedia.org/wiki/Paris");
  const results = parse(await call("brain_search", { query: "capital city of France" }));
  expect(results.some((r: { id: string }) => r.id === n.id)).toBe(true);
});

test("brain_mutate on unknown id errors cleanly", async () => {
  expect((await call("brain_mutate", { id: "nope", answer: "x", citation: "https://x" })).isError).toBe(true);
});

test("brain_mutate REJECTS an answer with no citation", async () => {
  const n = parse(await call("brain_create", { text: "needs a source" }));
  const res = await call("brain_mutate", { id: n.id, answer: "an uncited factual claim" });
  expect(res.isError).toBe(true);
  expect(res.content[0]!.text).toContain("citation required");
});
