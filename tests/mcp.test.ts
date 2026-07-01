// End-to-end: spawn the real server over stdio and drive it with an MCP client, exactly how
// an agent talks to it. Proves the three tools work against the real core.
import { test, expect, beforeAll, afterAll } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const TEST_DB = join(tmpdir(), `cairn-mcp-${randomUUID()}.db`);
let client: Client;

beforeAll(async () => {
  const transport = new StdioClientTransport({
    command: "bun",
    args: ["src/mcp/server.ts"],
    env: { ...process.env, CAIRN_DB_PATH: TEST_DB, CAIRN_SEARCH_LIMIT: "5" },
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

test("exposes the brain tools", async () => {
  const { tools } = await client.listTools();
  expect(tools.map((t) => t.name).sort()).toEqual(["brain_create", "brain_delete", "brain_mutate", "brain_search", "skill_output", "skill_review", "skill_search", "skill_segment"]);
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

test("skill_output bakes in the loop's forced label and HARD-rejects incomplete ones", async () => {
  const dbPath = join(tmpdir(), `cairn-so-${randomUUID()}.db`);
  // The label is supplied by the loop via CAIRN_SKILL_FORCED_LABEL, never by the learner, so spin up one
  // server per label scenario (the env is fixed per process, like a real learner spawn).
  const spawn = async (forcedLabel?: string) => {
    const outPath = join(tmpdir(), `cairn-out-${randomUUID()}.json`);
    const env: Record<string, string> = { ...process.env, CAIRN_DB_PATH: dbPath, CAIRN_SKILL_OUTPUT_PATH: outPath };
    if (forcedLabel !== undefined) env.CAIRN_SKILL_FORCED_LABEL = forcedLabel;
    const transport = new StdioClientTransport({ command: "bun", args: ["src/mcp/server.ts"], env });
    const c = new Client({ name: "cairn-so-test", version: "1.0.0" });
    await c.connect(transport);
    const call = (args: Record<string, unknown>) => c.callTool({ name: "skill_output", arguments: args }) as Promise<{ isError?: boolean; content: { text: string }[] }>;
    return { c, call, outPath };
  };

  // Labeled task: the loop supplies "haiku"; the learner submits NO label, and the capture bakes it in.
  const L = await spawn("haiku");
  try {
    const review = { score: 0.78, right: "clean cut", wrong: "stock imagery", improve: "fresher second image", master: "1. pick a kigo\n2. count 5-7-5", explanation: "The best runs cut two clean images and avoid stock phrasing." };
    const ok = await L.call(review);
    expect(JSON.parse(ok.content[0]!.text).ok).toBe(true);
    expect(JSON.parse(readFileSync(L.outPath, "utf8"))).toEqual({ label: "haiku", ...review }); // loop's label baked in

    // A review with NO master errors back, telling the learner to resend; it does not write.
    try { rmSync(L.outPath); } catch { /* ignore */ }
    const noMaster = await L.call({ ...review, master: "" });
    expect(noMaster.isError).toBe(true);
    expect(noMaster.content[0]!.text).toMatch(/master must be a non-empty/i);
    expect(existsSync(L.outPath)).toBe(false); // nothing captured on rejection

    // A review with NO explanation errors back too (the reviewer-only rationale is required).
    const noExplanation = await L.call({ ...review, explanation: "" });
    expect(noExplanation.isError).toBe(true);
    expect(noExplanation.content[0]!.text).toMatch(/explanation must be a non-empty/i);

    // A score out of [0,1] is rejected.
    const badScore = await L.call({ ...review, score: 1.7 });
    expect(badScore.isError).toBe(true);
    expect(badScore.content[0]!.text).toMatch(/score must be a number/i);
  } finally {
    await L.c.close();
    try { rmSync(L.outPath); } catch { /* ignore */ }
  }

  // Non-task: the loop forced an EMPTY label. A master is rejected; empty master+explanation is accepted.
  const N = await spawn("");
  try {
    const withMaster = await N.call({ score: 0, right: "", wrong: "", improve: "", master: "some steps", explanation: "" });
    expect(withMaster.isError).toBe(true);
    expect(withMaster.content[0]!.text).toMatch(/must be empty when label is empty/i);

    const nonTask = await N.call({ score: 0, right: "", wrong: "", improve: "", master: "", explanation: "" });
    expect(JSON.parse(nonTask.content[0]!.text).ok).toBe(true);
  } finally {
    await N.c.close();
    try { rmSync(N.outPath); } catch { /* ignore */ }
  }
});

test("skill_segment captures the submitted deliverables as clean JSON (trim/lowercase/dedup)", async () => {
  const segPath = join(tmpdir(), `cairn-seg-${randomUUID()}.json`);
  const env: Record<string, string> = { ...process.env, CAIRN_DB_PATH: TEST_DB, CAIRN_SKILL_SEGMENT_PATH: segPath };
  const transport = new StdioClientTransport({ command: "bun", args: ["src/mcp/server.ts"], env });
  const c = new Client({ name: "cairn-seg-test", version: "1.0.0" });
  await c.connect(transport);
  const call = (args: Record<string, unknown>) => c.callTool({ name: "skill_segment", arguments: args }) as Promise<{ isError?: boolean; content: { text: string }[] }>;
  try {
    // A turn that wrote a story AND reviewed it, with a duplicate and a stray-cased label to canonicalize.
    const r = await call({ deliverables: [
      { label: "Short Story", what: "the lighthouse story" },
      { label: "short story review", what: "the critique" },
      { label: "short story", what: "dup, dropped" },
    ] });
    expect(JSON.parse(r.content[0]!.text)).toMatchObject({ ok: true, count: 2 });
    expect(JSON.parse(readFileSync(segPath, "utf8"))).toEqual({ deliverables: [
      { label: "short story", what: "the lighthouse story" },
      { label: "short story review", what: "the critique" },
    ] });

    // A non-task submits an empty list — captured as such, never a failure.
    const empty = await call({ deliverables: [] });
    expect(JSON.parse(empty.content[0]!.text)).toMatchObject({ ok: true, count: 0 });
    expect(JSON.parse(readFileSync(segPath, "utf8"))).toEqual({ deliverables: [] });
  } finally {
    await c.close();
    try { rmSync(segPath); } catch { /* ignore */ }
  }
});

test("skill_review acknowledges the agent's finished-deliverable signal (the host hook does the firing)", async () => {
  const withWhat = await call("skill_review", { what: "the short story about the clockmaker" });
  expect(JSON.parse(withWhat.content[0]!.text)).toMatchObject({ ok: true, queued: true, what: "the short story about the clockmaker" });
  // `what` is optional — a bare call still acknowledges.
  const bare = await call("skill_review", {});
  expect(JSON.parse(bare.content[0]!.text)).toMatchObject({ ok: true, queued: true });
});
