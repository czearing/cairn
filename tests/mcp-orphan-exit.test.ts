// Regression test for the orphaned `bun src/mcp/server.ts` process leak: when the host that spawned
// this process exits, its end of the stdio pipe closes and this process' stdin reaches EOF. The MCP
// SDK's StdioServerTransport never listens for stdin 'end'/'close' (see the SDK's server/stdio.js), so
// without our own listener the server would keep running forever with no host attached. This test ends
// the server's stdin directly (bypassing the MCP client's close(), which also sends SIGTERM/SIGKILL
// after a timeout and would mask a missing exit-on-EOF handler) and asserts the process exits on its
// own, the way it would if its real host had simply disappeared.
import { test, expect } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { ChildProcess } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

test("the MCP server exits on its own when its host disconnects, instead of becoming orphaned", async () => {
  const transport = new StdioClientTransport({
    command: "bun",
    args: ["src/mcp/server.ts"],
    env: {
      ...process.env,
      CAIRN_DB_PATH: join(tmpdir(), `cairn-mcp-orphan-${randomUUID()}.db`),
      CAIRN_COPILOT_HOOK_PATH: join(tmpdir(), `cairn-mcp-orphan-hook-${randomUUID()}.json`),
      CAIRN_EMBED_NO_SERVER: "1",
      CAIRN_ENGINE_NO_SERVER: "1",
    },
  });
  const client = new Client({ name: "cairn-orphan-test", version: "1.0.0" });
  await client.connect(transport);

  // Confirm the server is actually up and answering before we simulate the host disappearing.
  await client.listTools();

  const child = (transport as unknown as { _process: ChildProcess })._process;
  expect(child).toBeDefined();

  const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
  // Close only stdin, exactly as happens when a parent process exits without killing its children:
  // the child's stdin pipe reaches EOF, but nothing sends it a signal.
  child.stdin?.end();

  const code = await Promise.race([
    exited,
    new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 5_000).unref()),
  ]);

  expect(code).not.toBe("timeout");
  expect(code).toBe(0);
}, 10_000);
