import { test, expect, beforeAll, afterAll } from "bun:test";
import { create, mutate } from "../src/core/neurons";
import { lastUserQuery, formatMemories, injectMemories } from "../src/proxy/inject";

// The proxy is proven without a real model: a mock upstream echoes the request it receives, so we can
// assert the recalled memory was injected into the system prompt before the request was forwarded.

let mock: ReturnType<typeof Bun.serve>;
let received: any = null;
let proxy: { port: number; stop: () => void };

beforeAll(async () => {
  // A stand-in for Ollama. It captures the forwarded body and returns a canned OpenAI-shaped reply.
  mock = Bun.serve({
    port: 0,
    async fetch(req) {
      received = await req.json();
      return Response.json({ id: "test", choices: [{ message: { role: "assistant", content: "ok" } }] });
    },
  });

  // Point the proxy at the mock and seed a memory the search should recall.
  process.env.CAIRN_PROXY_BASE_URL = `http://localhost:${mock.port}/v1`;
  process.env.CAIRN_PROXY_PORT = "0";
  const n = await create("What is the capital of France?");
  await mutate(n.id, { answer: "The capital of France is Paris.", citation: "https://example.com" });

  proxy = (await import("../src/proxy/server")).start();
}, 60_000);

afterAll(() => {
  proxy?.stop();
  mock?.stop(true);
  for (const k of ["CAIRN_PROXY_BASE_URL", "CAIRN_PROXY_PORT", "CAIRN_PROXY_NO_RECALL"]) delete process.env[k];
});

test("lastUserQuery returns the most recent user message", () => {
  const q = lastUserQuery([
    { role: "system", content: "be nice" },
    { role: "user", content: "first" },
    { role: "assistant", content: "hi" },
    { role: "user", content: "the capital of France" },
  ]);
  expect(q).toBe("the capital of France");
});

test("injectMemories appends to an existing system message", () => {
  const out = injectMemories([{ role: "system", content: "base" }, { role: "user", content: "q" }], "MEM");
  expect(out[0]!.content).toContain("base");
  expect(out[0]!.content).toContain("MEM");
  expect(out).toHaveLength(2);
});

test("injectMemories adds a system message when none exists", () => {
  const out = injectMemories([{ role: "user", content: "q" }], "MEM");
  expect(out[0]).toEqual({ role: "system", content: "MEM" });
});

test("formatMemories renders answered neurons as question and answer", () => {
  const block = formatMemories([{ text: "Q?", answer: "A." }]);
  expect(block).toContain("Q?");
  expect(block).toContain("A.");
});

test("the proxy recalls a memory and injects it into the forwarded system prompt", async () => {
  const res = await fetch(`http://localhost:${proxy.port}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "anything",
      messages: [{ role: "user", content: "Remind me, what is the capital of France?" }],
    }),
  });

  expect(res.status).toBe(200);
  const reply = (await res.json()) as any;
  expect(reply.choices[0].message.content).toBe("ok"); // response passes through unchanged

  // The mock saw the injected memory in a system message.
  const systemText = (received.messages as any[])
    .filter((m) => m.role === "system")
    .map((m) => m.content)
    .join("\n");
  expect(systemText).toContain("Paris");
}, 30_000);

test("CAIRN_PROXY_NO_RECALL forwards the request untouched", async () => {
  process.env.CAIRN_PROXY_NO_RECALL = "1";
  const noRecall = (await import("../src/proxy/server")).start();
  try {
    received = null;
    await fetch(`http://localhost:${noRecall.port}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "x", messages: [{ role: "user", content: "capital of France?" }] }),
    });
    const hasSystem = (received.messages as any[]).some((m) => m.role === "system");
    expect(hasSystem).toBe(false);
  } finally {
    noRecall.stop();
    delete process.env.CAIRN_PROXY_NO_RECALL;
  }
}, 30_000);
