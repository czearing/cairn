import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { mcpLaunchArgs } from "../src/mcp/bundle";

test("Bun hot reload updates an MCP handler without replacing its stdio process", async () => {
  const root = join(import.meta.dir, "..", `.cairn-hot-reload-${randomUUID()}`);
  mkdirSync(root);
  const sdk = join(import.meta.dir, "..", "node_modules", "@modelcontextprotocol", "sdk", "dist", "esm")
    .replaceAll("\\", "/");
  writeFileSync(join(root, "logic.ts"), 'export const value = "before"; export const description = "before schema";\n');
  writeFileSync(join(root, "server.ts"), `
    import { McpServer } from "${sdk}/server/mcp.js";
    import { StdioServerTransport } from "${sdk}/server/stdio.js";
    const state = globalThis;
    const server = state.probeServer ??= new McpServer({ name: "probe", version: "1" });
    const { description } = await import("./logic");
    const callback = async () => {
      const { value } = await import("./logic");
      return { content: [{ type: "text", text: JSON.stringify({ value, pid: process.pid }) }] };
    };
    if (state.probeTool) state.probeTool.update({ description, callback });
    else state.probeTool = server.tool("probe", description, callback);
    if (!state.probeConnected) {
      state.probeConnected = true;
      await server.connect(new StdioServerTransport());
    } else server.sendToolListChanged();
  `);
  const transport = new StdioClientTransport({
    command: Bun.which("bun") ?? "bun",
    args: ["--hot", `--cwd=${root}`, join(root, "server.ts")],
    stderr: "pipe",
  });
  const client = new Client({ name: "hot-reload-test", version: "1" });
  await client.connect(transport);
  try {
    const call = async () => {
      const result = await client.callTool({ name: "probe", arguments: {} }) as {
        content: { text: string }[];
      };
      return JSON.parse(result.content[0]!.text) as { value: string; pid: number };
    };
    const before = await call();
    writeFileSync(join(root, "logic.ts"), 'export const value = "after"; export const description = "after schema";\n');
    let after = before;
    let description = "";
    for (let attempt = 0; attempt < 50 && (after.value !== "after" || description !== "after schema"); attempt++) {
      await Bun.sleep(100);
      after = await call();
      description = (await client.listTools()).tools.find((tool) => tool.name === "probe")?.description ?? "";
    }
    expect(after).toEqual({ value: "after", pid: before.pid });
    expect(description).toBe("after schema");
  } finally {
    await client.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 10_000);

test("the launch arguments hosts are installed with are the ones that reload", async () => {
  // Hosts used to launch `--smol dist/mcp-server.js`. That bundle is a snapshot: a running session kept
  // the code it started with until the user restarted it, which is exactly the complaint. `--hot` cannot
  // point at the bundle either, because on Windows it holds a handle on its entry and the rebuild's
  // rename swap fails with EPERM. So the installed launch must be `--hot` on the SOURCE entry, and this
  // test spawns the real production arguments rather than a hand-written copy of them.
  const args = mcpLaunchArgs();
  expect(args).toContain("--hot");
  expect(args.some((arg) => arg.replaceAll("\\", "/").includes("/dist/"))).toBe(false);

  const repository = join(import.meta.dir, "..");
  const hook = join(repository, `.cairn-launch-hook-${randomUUID()}.json`);
  const database = join(repository, `.cairn-launch-db-${randomUUID()}.db`);
  writeFileSync(hook, JSON.stringify({ cairnRelease: "0.1.0+before" }));
  const transport = new StdioClientTransport({
    command: Bun.which("bun") ?? "bun",
    args,
    env: {
      ...process.env,
      CAIRN_COPILOT_HOOK_PATH: hook,
      CAIRN_DB_PATH: database,
      CAIRN_EMBED_NO_SERVER: "1",
      CAIRN_ENGINE_NO_SERVER: "1",
    },
  });
  const client = new Client({ name: "cairn-launch-args-test", version: "1" });
  await client.connect(transport);
  try {
    const call = async () => {
      const result = await client.callTool({
        name: "brain_delete",
        arguments: { id: randomUUID() },
      }) as { _meta?: { cairn?: { version?: string; pid?: number } } };
      return result._meta?.cairn;
    };
    const before = await call();
    writeFileSync(hook, JSON.stringify({ cairnRelease: "0.1.0+after" }));
    const after = await call();
    expect(before).toMatchObject({ version: "0.1.0+before", pid: expect.any(Number) });
    expect(after).toMatchObject({ version: "0.1.0+after", pid: before?.pid });
  } finally {
    await client.close();
    rmSync(hook, { force: true });
    rmSync(database, { force: true });
  }
}, 20_000);

test("a connected Cairn server observes an installed release change in the same process", async () => {
  const repository = join(import.meta.dir, "..");
  const hook = join(repository, `.cairn-hot-hook-${randomUUID()}.json`);
  const database = join(repository, `.cairn-hot-db-${randomUUID()}.db`);
  writeFileSync(hook, JSON.stringify({ cairnRelease: "0.1.0+before" }));
  const transport = new StdioClientTransport({
    command: Bun.which("bun") ?? "bun",
    args: ["--hot", `--cwd=${repository}`, join(repository, "src", "mcp", "server.ts")],
    env: {
      ...process.env,
      CAIRN_COPILOT_HOOK_PATH: hook,
      CAIRN_DB_PATH: database,
      CAIRN_EMBED_NO_SERVER: "1",
      CAIRN_ENGINE_NO_SERVER: "1",
    },
  });
  const client = new Client({ name: "cairn-release-test", version: "1" });
  await client.connect(transport);
  try {
    const call = async () => {
      const result = await client.callTool({
        name: "brain_delete",
        arguments: { id: randomUUID() },
      }) as {
        _meta?: { cairn?: { version?: string; pid?: number } };
      };
      return result._meta?.cairn;
    };
    const before = await call();
    writeFileSync(hook, JSON.stringify({ cairnRelease: "0.1.0+after" }));
    const after = await call();
    expect(before).toMatchObject({ version: "0.1.0+before", pid: expect.any(Number) });
    expect(after).toMatchObject({ version: "0.1.0+after", pid: before?.pid });
  } finally {
    await client.close();
    rmSync(hook, { force: true });
    rmSync(database, { force: true });
  }
}, 10_000);
