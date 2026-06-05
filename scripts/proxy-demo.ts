#!/usr/bin/env bun
// A live, self-contained demo of `cairn proxy`. It seeds a throwaway brain, starts a mock model that
// reports what it was sent, runs the proxy in front of it, and sends one chat request. You see the
// memory the proxy recalled and injected. No Ollama or API key needed. Run: bun scripts/proxy-demo.ts

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "cairn-proxy-demo-"));
process.env.CAIRN_DB_PATH = join(dir, "brain.db");

const { create, mutate } = await import("../src/core/neurons");
const seed = await create("Which database does Cairn use to store the brain?");
await mutate(seed.id, {
  answer: "Cairn stores the brain in a local SQLite database, opened through bun:sqlite.",
  citation: "https://github.com/czearing/cairn",
});

// A stand-in for Ollama. It records the system prompt it received and returns a fixed reply.
let injected = "";
const mock = Bun.serve({
  port: 0,
  async fetch(req) {
    const body = (await req.json()) as { messages: { role: string; content: string }[] };
    injected = body.messages.filter((m) => m.role === "system").map((m) => m.content).join("\n");
    return Response.json({ id: "demo", choices: [{ message: { role: "assistant", content: "(a real model answers here)" } }] });
  },
});

process.env.CAIRN_PROXY_BASE_URL = `http://localhost:${mock.port}/v1`;
process.env.CAIRN_PROXY_PORT = "0";
const proxy = (await import("../src/proxy/server")).start();

const question = "What does Cairn use for storage?";
console.log("Agent asks:\n  " + question + "\n");

const res = await fetch(`http://localhost:${proxy.port}/v1/chat/completions`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ model: "demo", messages: [{ role: "user", content: question }] }),
});
const reply = (await res.json()) as { choices: { message: { content: string } }[] };

console.log("Cairn recalled and injected into the system prompt:\n" + (injected || "  (nothing recalled)") + "\n");
console.log("Model replied:\n  " + reply.choices[0]!.message.content);
console.log("\nWith real Ollama: `ollama serve`, then `cairn proxy`, then point your client at http://localhost:11435/v1");

proxy.stop();
mock.stop(true);
try {
  rmSync(dir, { recursive: true, force: true });
} catch {
  // the SQLite handle can linger on Windows; the OS reclaims the temp dir later
}
process.exit(0);
