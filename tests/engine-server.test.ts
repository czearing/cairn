import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import type {
  EngineLock,
  EngineRequest,
  EngineResponse,
} from "../src/core/engine-protocol";

const repository = join(import.meta.dir, "..");
const bun = Bun.which("bun") ?? "bun";

async function runBun(script: string, env: NodeJS.ProcessEnv): Promise<string> {
  const child = spawn(bun, ["-e", script], {
    cwd: repository,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += String(chunk); });
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });
  const exit = await new Promise<number | null>((resolve) => child.once("exit", resolve));
  if (exit !== 0) throw new Error(`client exited ${exit}: ${stderr}`);
  return stdout.trim();
}

async function waitForLock(path: string): Promise<EngineLock> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (existsSync(path)) {
      try {
        const lock = JSON.parse(readFileSync(path, "utf8")) as EngineLock;
        const response = await fetch(`http://127.0.0.1:${lock.port}/v1/health`, {
          headers: { authorization: `Bearer ${lock.token}` },
        });
        if (response.ok) return lock;
      } catch { /* still starting */ }
    }
    await Bun.sleep(50);
  }
  throw new Error("engine server did not become ready");
}

test("engine server authenticates, deduplicates, mutates, searches, and stays singleton", async () => {
  const marker = randomUUID();
  const dbPath = join(tmpdir(), `cairn-engine-${marker}.db`);
  const lockPath = join(tmpdir(), `cairn-engine-${marker}.json`);
  const startPath = join(tmpdir(), `cairn-engine-start-${marker}.json`);
  const env = {
    ...process.env,
    CAIRN_DB_PATH: dbPath,
    CAIRN_CONFIG_PATH: join(tmpdir(), `cairn-engine-config-${marker}.json`),
    CAIRN_ENGINE_LOCKFILE: lockPath,
    CAIRN_ENGINE_STARTFILE: startPath,
    CAIRN_ENGINE_ALLOW_TEMP: "1",
    CAIRN_EMBED_NO_SERVER: "1",
    CAIRN_USAGE: "0",
    CAIRN_ENGINE_IDLE_MS: "60000",
  };
  const first = spawn(bun, ["src/core/engine-server.ts"], {
    cwd: repository,
    env,
    stdio: ["ignore", "ignore", "pipe"],
  });
  try {
    const lock = await waitForLock(lockPath);
    expect((await fetch(`http://127.0.0.1:${lock.port}/v1/health`)).status).toBe(401);

    const call = async (request: EngineRequest): Promise<EngineResponse> => {
      const response = await fetch(`http://127.0.0.1:${lock.port}/v1/execute`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${lock.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(request),
      });
      expect(response.status).toBe(200);
      return response.json() as Promise<EngineResponse>;
    };
    const id = randomUUID();
    const create: EngineRequest = {
      requestId: randomUUID(),
      operation: "create",
      payload: { id, text: "How does the shared Cairn engine preserve exact retrieval?", edges: [] },
    };
    const created = await call(create);
    expect(created).toMatchObject({ ok: true, result: { neuron: { id } } });
    expect(await call(create)).toEqual(created);

    const searched = await call({
      requestId: randomUUID(),
      operation: "search",
      payload: {
        query: "shared semantic engine retrieval",
        options: {
          relevanceThreshold: 0.3,
          relativeFloor: 0,
          searchGraphBoost: 0.1,
          expandSubtree: false,
          vectorIndexThreshold: 10_000,
        },
      },
    });
    expect(searched.ok && Array.isArray(searched.result)
      && searched.result.some((item) => typeof item === "object" && item !== null && "id" in item && item.id === id))
      .toBe(true);

    const mutated = await call({
      requestId: randomUUID(),
      operation: "mutate",
      payload: {
        id,
        patch: { answer: "Through one authenticated owner.", citation: "https://example.com/engine" },
      },
    });
    expect(mutated).toMatchObject({ ok: true, result: { id, answer: "Through one authenticated owner." } });
    const linkedId = randomUUID();
    await call({
      requestId: randomUUID(),
      operation: "create",
      payload: { id: linkedId, text: "What should the engine link target contain?", edges: [] },
    });
    expect(await call({
      requestId: randomUUID(),
      operation: "link",
      payload: { a: id, b: linkedId },
    })).toEqual({ ok: true, result: true });
    expect(await call({
      requestId: randomUUID(),
      operation: "unlink",
      payload: { a: id, b: linkedId },
    })).toEqual({ ok: true, result: true });
    expect(await call({
      requestId: randomUUID(),
      operation: "delete",
      payload: { id },
    })).toEqual({ ok: true, result: true });
    await call({
      requestId: randomUUID(),
      operation: "delete",
      payload: { id: linkedId },
    });

    const second = spawn(bun, ["src/core/engine-server.ts"], {
      cwd: repository,
      env,
      stdio: "ignore",
    });
    const secondExit = await new Promise<number | null>((resolve) => second.once("exit", resolve));
    expect(secondExit).toBe(0);
    expect((await waitForLock(lockPath)).pid).toBe(lock.pid);
  } finally {
    try { first.kill("SIGTERM"); } catch { /* exited */ }
    await new Promise((resolve) => first.once("exit", resolve));
    for (const path of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`, lockPath, startPath]) {
      rmSync(path, { force: true });
    }
  }
}, 30_000);

test("ten concurrent engine starts converge to one owner", async () => {
  const marker = randomUUID();
  const dbPath = join(tmpdir(), `cairn-engine-race-${marker}.db`);
  const lockPath = join(tmpdir(), `cairn-engine-race-${marker}.json`);
  const startPath = join(tmpdir(), `cairn-engine-race-start-${marker}.json`);
  const env = {
    ...process.env,
    CAIRN_DB_PATH: dbPath,
    CAIRN_CONFIG_PATH: join(tmpdir(), `cairn-engine-race-config-${marker}.json`),
    CAIRN_ENGINE_LOCKFILE: lockPath,
    CAIRN_ENGINE_STARTFILE: startPath,
    CAIRN_ENGINE_ALLOW_TEMP: "1",
    CAIRN_ENGINE_SKIP_WARMUP: "1",
    CAIRN_EMBED_NO_SERVER: "1",
    CAIRN_USAGE: "0",
    CAIRN_ENGINE_IDLE_MS: "60000",
  };
  const children = Array.from({ length: 10 }, () => spawn(
    bun,
    ["src/core/engine-server.ts"],
    { cwd: repository, env, stdio: "ignore" },
  ));
  try {
    const lock = await waitForLock(lockPath);
    let alive = children;
    for (let attempt = 0; attempt < 100; attempt++) {
      alive = children.filter((child) => child.exitCode === null && child.signalCode === null);
      if (alive.length <= 1) break;
      await Bun.sleep(50);
    }
    expect(alive).toHaveLength(1);
    expect(alive[0]!.pid).toBe(lock.pid);
  } finally {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) {
        try { child.kill("SIGTERM"); } catch { /* exited */ }
      }
    }
    await Bun.sleep(100);
    for (const path of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`, lockPath, startPath]) {
      rmSync(path, { force: true });
    }
  }
}, 15_000);

test("a cold search waits through the bounded readiness retry instead of falling back", async () => {
  const marker = randomUUID();
  const dbPath = join(tmpdir(), `cairn-engine-cold-${marker}.db`);
  const lockPath = join(tmpdir(), `cairn-engine-cold-${marker}.json`);
  const startPath = join(tmpdir(), `cairn-engine-cold-start-${marker}.json`);
  const env = {
    ...process.env,
    CAIRN_DB_PATH: dbPath,
    CAIRN_CONFIG_PATH: join(tmpdir(), `cairn-engine-cold-config-${marker}.json`),
    CAIRN_ENGINE_LOCKFILE: lockPath,
    CAIRN_ENGINE_STARTFILE: startPath,
    CAIRN_ENGINE_ALLOW_TEMP: "1",
    CAIRN_ENGINE_SKIP_WARMUP: "1",
    CAIRN_ENGINE_STARTUP_WAIT_MS: "0",
    CAIRN_ENGINE_COLD_SEARCH_RETRY_MS: "5000",
    CAIRN_EMBED_NO_SERVER: "1",
    CAIRN_USAGE: "1",
    CAIRN_ENGINE_IDLE_MS: "3000",
  };
  let ownerPid: number | null = null;
  try {
    const source = await runBun(`
      import { Database } from "bun:sqlite";
      import { engineSearch } from "./src/core/engine-client";
      await engineSearch("bounded cold readiness ${marker}", {
        host: "copilot", sessionId: "cold-search", turnSeq: 1,
      });
      const db = new Database(process.env.CAIRN_DB_PATH!);
      const row = db.query("SELECT source FROM telemetry_events WHERE kind='engine_transport' ORDER BY ts DESC LIMIT 1").get();
      db.close();
      console.log(JSON.stringify(row));
    `, env);
    expect(JSON.parse(source)).toEqual({ source: "daemon" });
    ownerPid = (await waitForLock(lockPath)).pid;
  } finally {
    if (ownerPid) {
      for (let attempt = 0; attempt < 100; attempt++) {
        try {
          process.kill(ownerPid, 0);
          await Bun.sleep(50);
        } catch {
          break;
        }
      }
    }
    for (const path of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`, lockPath, startPath]) {
      for (let attempt = 0; attempt < 100; attempt++) {
        try {
          rmSync(path, { force: true });
          break;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EBUSY" || attempt === 99) throw error;
          await Bun.sleep(50);
        }
      }
    }
  }
}, 15_000);

test("clients share writes and recover from an engine crash without duplicate creates", async () => {
  const marker = randomUUID();
  const id = randomUUID();
  const dbPath = join(tmpdir(), `cairn-engine-restart-${marker}.db`);
  const lockPath = join(tmpdir(), `cairn-engine-restart-${marker}.json`);
  const startPath = join(tmpdir(), `cairn-engine-restart-start-${marker}.json`);
  const env = {
    ...process.env,
    CAIRN_DB_PATH: dbPath,
    CAIRN_CONFIG_PATH: join(tmpdir(), `cairn-engine-restart-config-${marker}.json`),
    CAIRN_ENGINE_LOCKFILE: lockPath,
    CAIRN_ENGINE_STARTFILE: startPath,
    CAIRN_ENGINE_ALLOW_TEMP: "1",
    CAIRN_ENGINE_SKIP_WARMUP: "1",
    CAIRN_EMBED_NO_SERVER: "1",
    CAIRN_USAGE: "0",
    CAIRN_ENGINE_IDLE_MS: "60000",
  };
  let ownerPid: number | null = null;
  try {
    const createScript = `
      import { engineCreate } from "./src/core/engine-client";
      const result = await engineCreate(
        "How do independent Cairn clients observe a shared engine write ${marker}?",
        [],
        undefined,
        "${id}",
      );
      console.log(result.neuron.id);
    `;
    expect(await runBun(createScript, env)).toBe(id);
    const first = await waitForLock(lockPath);
    ownerPid = first.pid;

    const searchScript = `
      import { engineSearch } from "./src/core/engine-client";
      const results = await engineSearch("independent shared engine write ${marker}");
      console.log(JSON.stringify(results.filter((item) => item.id === "${id}").map((item) => item.id)));
    `;
    expect(JSON.parse(await runBun(searchScript, env))).toEqual([id]);

    process.kill(first.pid);
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        process.kill(first.pid, 0);
        await Bun.sleep(25);
      } catch {
        break;
      }
    }

    expect(await runBun(createScript, env)).toBe(id);
    const restarted = await waitForLock(lockPath);
    ownerPid = restarted.pid;
    expect(restarted.pid).not.toBe(first.pid);
    expect(JSON.parse(await runBun(searchScript, env))).toEqual([id]);
  } finally {
    if (ownerPid !== null) {
      try { process.kill(ownerPid); } catch { /* exited */ }
    }
    await Bun.sleep(100);
    for (const path of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`, lockPath, startPath]) {
      rmSync(path, { force: true });
    }
  }
}, 60_000);
