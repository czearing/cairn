// End-to-end: spawn the real server over stdio and drive it with an MCP client, exactly how
// an agent talks to it. Proves the three tools work against the real core.
import { test, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { getLoadablePath } from "sqlite-vec";
import { releaseVersion } from "../src/core/release";

const TEST_DB = join(tmpdir(), `cairn-mcp-${randomUUID()}.db`);
let client: Client;

beforeAll(async () => {
  const transport = new StdioClientTransport({
    command: "bun",
    args: ["src/mcp/server.ts"],
    env: { ...process.env, CAIRN_DB_PATH: TEST_DB, CAIRN_SEARCH_LIMIT: "5", CAIRN_SKILLS: "1" },
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

test("exposes only the agent-owned brain and skill tools", async () => {
  const { tools } = await client.listTools();
  expect(tools.map((t) => t.name).sort()).toEqual(["brain_create", "brain_delete", "brain_mutate", "brain_search", "skill_create", "skill_edit", "skill_search", "skill_select"]);
});

test("brain_create returns a neuron with an id and a viewer url", async () => {
  const n = parse(await call("brain_create", { text: "How do I write a haiku poem?" }));
  expect(n.id).toBeTruthy();
  expect(n.answer).toBe("");
  expect(n.url).toContain(`/node/${n.id}`);
});

test("MCP calls record local size and latency telemetry", async () => {
  await call("brain_delete", { id: `missing-${randomUUID()}` });
  const database = new Database(TEST_DB);
  const event = database.query(`SELECT tool_name,input_chars,output_chars,duration_ms,success,
      release_fingerprint,version,run_class
    FROM usage_events WHERE event_kind='tool' AND tool_name='brain_delete'
    ORDER BY id DESC LIMIT 1`).get() as {
      tool_name: string;
      input_chars: number;
      output_chars: number;
      duration_ms: number;
      success: number;
      release_fingerprint: string;
      version: string;
      run_class: string;
    };
  const columns = database.query("PRAGMA table_info(usage_events)").all() as { name: string }[];
  database.close();
  expect(event.tool_name).toBe("brain_delete");
  expect(event.input_chars).toBeGreaterThan(0);
  expect(event.output_chars).toBeGreaterThan(0);
  expect(event.duration_ms).toBeGreaterThanOrEqual(0);
  expect(event.success).toBe(1);
  expect(event.release_fingerprint).toHaveLength(24);
  expect(event.version).toBe(releaseVersion);
  expect(event.run_class).toBe("human");
  expect(columns.map((column) => column.name)).not.toContain("content");
});

test("brain_create works first in a fresh process when the database already contains a vec0 index", async () => {
  const path = join(tmpdir(), `cairn-mcp-existing-vec-${randomUUID()}.db`);
  const database = new Database(path);
  database.loadExtension(getLoadablePath());
  database.run("CREATE VIRTUAL TABLE existing_vectors USING vec0(id TEXT PRIMARY KEY, embedding float[3])");
  database.close();

  const transport = new StdioClientTransport({
    command: "bun",
    args: ["src/mcp/server.ts"],
    env: { ...process.env, CAIRN_DB_PATH: path, CAIRN_SKILLS: "1" },
  });
  const freshClient = new Client({ name: "cairn-existing-vec-test", version: "1.0.0" });
  await freshClient.connect(transport);
  try {
    const created = parse(await freshClient.callTool({
      name: "brain_create",
      arguments: { text: "How does a cold MCP process create its first node?" },
    }) as { content: { text: string }[] });
    expect(created.id).toBeTruthy();
  } finally {
    await freshClient.close();
    rmSync(path, { force: true });
  }
});

test("brain_create rejects empty text", async () => {
  expect((await call("brain_create", { text: "   " })).isError).toBe(true);
});

test("brain_create no longer rejects by phrasing — a yes/no title is accepted (the model decides)", async () => {
  expect(parse(await call("brain_create", { text: "Does compression distinguish great poems?" })).id).toBeTruthy();
});

test("brain_search finds a neuron by meaning", async () => {
  await call("brain_create", { text: "How do I write a haiku poem?" });
  const results = parse(await call("brain_search", { query: "compose some verse" }));
  expect(results.some((r: { text: string }) => r.text.includes("haiku"))).toBe(true);
});

test("brain_search caps the result set at CAIRN_SEARCH_LIMIT and stays score-ordered", async () => {
  for (let i = 0; i < 9; i++) await call("brain_create", { text: `a short poem about season number ${i}` });
  const results = parse(await call("brain_search", { query: "poetry and verse" })) as { score: number }[];
  expect(results.length).toBeLessThanOrEqual(5); // capped, even though 9+ neurons match
  for (let i = 1; i < results.length; i++) expect(results[i - 1]!.score).toBeGreaterThanOrEqual(results[i]!.score);
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

test("brain_mutate REJECTS an insanely long answer with a concision prompt", async () => {
  const n = parse(await call("brain_create", { text: "a node that will get a bloated answer" }));
  const res = await call("brain_mutate", { id: n.id, answer: "x".repeat(50_000), citation: "https://x" });
  expect(res.isError).toBe(true);
  expect(res.content[0]!.text).toMatch(/too long/i);
  expect(res.content[0]!.text).toMatch(/concis/i);
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

test("brain_search returns a lean shape: keeps id/text/answer/score, drops edges and url", async () => {
  const a = parse(await call("brain_create", { text: "How do I prune a bonsai tree?" }));
  // give it a neighbor so the node genuinely has an edge that must NOT appear in the search payload
  await call("brain_create", { text: "How do I water a bonsai tree?", edges: [a.id] });
  await call("brain_mutate", { id: a.id, answer: "Prune in early spring.", citation: "https://example.com/bonsai" });
  const results = parse(await call("brain_search", { query: "bonsai pruning" })) as Record<string, unknown>[];
  const hit = results.find((r) => r.id === a.id)!;
  expect(hit).toBeTruthy();
  expect(hit.answer).toBe("Prune in early spring.");
  expect(typeof hit.score).toBe("number");
  expect(hit.citation).toBe("https://example.com/bonsai");
  expect(hit).not.toHaveProperty("edges"); // server-only graph data, not shipped to the agent
  expect(hit).not.toHaveProperty("url"); // derivable from id; only on create/mutate returns
});

test("brain_search attaches compact prior/next context from the reasoning graph, not raw edges", async () => {
  const root = parse(await call("brain_create", { text: "How do I brew espresso?" }));
  const mid = parse(await call("brain_create", { text: "What grind size suits espresso?", edges: [root.id] }));
  await call("brain_create", { text: "What pressure suits espresso?", edges: [mid.id] }); // a child of mid
  await call("brain_mutate", { id: mid.id, answer: "Fine, near table-salt grind.", citation: "https://example.com/grind" });

  const results = parse(await call("brain_search", { query: "espresso grind size" })) as Record<string, unknown>[];
  const hit = results.find((r) => r.id === mid.id)!;
  expect(hit).toBeTruthy();
  // The agent recalls the fact AND where it sits in the reasoning: the question above and below it.
  expect(hit.prior).toBe("How do I brew espresso?"); // parent, the question this came from
  expect(hit.next).toBe("What pressure suits espresso?"); // child, where the reasoning went
  expect(hit).not.toHaveProperty("edges"); // still no raw neighbor UUIDs
  // No bloat: context is two short question strings, not the neighbors' full bodies.
  expect((hit.prior as string).length).toBeLessThan(160);
  expect((hit.next as string).length).toBeLessThan(160);
});

test("brain_delete removes a thought", async () => {
  const n = parse(await call("brain_create", { text: "to delete" }));
  expect(parse(await call("brain_delete", { id: n.id })).deleted).toBe(true);
  expect(parse(await call("brain_delete", { id: n.id })).deleted).toBe(false);
});

test("skill_create mints a new skill and remains idempotent", async () => {
  const metadata = {
    title: "Flash Fiction",
    description: "Use for writing complete 500-word stories and compact fictional scenes with a clear turn and deliberate ending.",
    plan: "1. Define the dramatic turn\n2. Draft the complete scene\n3. Revise the ending",
    whyExistingSkillsDoNotFit: "The current catalog has no general short-fiction writing capability.",
  };
  const created = parse(await call("skill_create", metadata));
  expect(created).toMatchObject({ created: true, title: "Flash Fiction" });
  expect(typeof created.id).toBe("string");
  expect(created.id.length).toBeGreaterThan(0);
  const again = parse(await call("skill_create", { ...metadata, title: "flash fiction" }));
  expect(again).toMatchObject({ created: false, id: created.id }); // idempotent: same normalized label -> same id

});

test("skill_create rejects narrow or unjustified capabilities", async () => {
  const narrowDescription = await call("skill_create", {
    title: "upset user response",
    description: "Reply to one upset user.",
    plan: "1. Reply politely\n2. Check tone",
    whyExistingSkillsDoNotFit: "The catalog does not contain this exact emotional response.",
  });
  expect(narrowDescription.isError).toBe(true);

  const noCatalogReason = await call("skill_create", {
    title: "debugging",
    description: "Use for debugging failing APIs and broken builds through evidence, hypotheses, and direct validation across reusable software failures.",
    plan: "1. Reproduce the failure\n2. Test one causal hypothesis",
    whyExistingSkillsDoNotFit: "none",
  });
  expect(noCatalogReason.isError).toBe(true);
});

test("skill_edit rewrites a skill's master directly (agent-driven fix, no grader needed)", async () => {
  const created = parse(await call("skill_create", {
    title: "flash edit",
    description: "Use for editing short paragraphs and tightening concise interface copy while preserving intent and improving clarity.",
    plan: "1. Identify the intended meaning\n2. Tighten the prose\n3. Verify the meaning remains",
    whyExistingSkillsDoNotFit: "No existing catalog entry handles compact prose editing.",
  }));
  const ok = parse(await call("skill_edit", { id: created.id, master: "1. do the thing better\n2. verify the result" }));
  expect(ok).toMatchObject({ ok: true, id: created.id, task: "flash edit" });
  const bad = await call("skill_edit", { id: "no-such-id", master: "1. x" });
  expect(bad.isError).toBe(true); // unknown id rejected
  const catalog = parse(await call("skill_search", { task: "flash edit" }));
  const selected = parse(await call("skill_select", { ids: [created.id], catalogVersion: catalog.catalogVersion }));
  expect(selected.selected[0].steps).toContain("do the thing better");
});
