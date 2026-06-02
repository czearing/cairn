import { test, expect, beforeAll, afterAll } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

process.env.CAIRN_DB_PATH = join(tmpdir(), `cairn-ui-${randomUUID()}.db`);

let server: ReturnType<typeof import("../src/ui/server").start>;
let created: { id: string };

beforeAll(async () => {
  created = await (await import("../src/core/neurons")).create("a viewer test neuron");
  server = (await import("../src/ui/server")).start(0); // port 0 → random free port
});
afterAll(() => server.stop());

test("/api/neurons returns the brain as JSON", async () => {
  const res = await fetch(`http://localhost:${server.port}/api/neurons`);
  const data = (await res.json()) as { neurons: { id: string }[] };
  expect(data.neurons.some((n) => n.id === created.id)).toBe(true);
});

test("/node/:id serves the viewer page", async () => {
  const res = await fetch(`http://localhost:${server.port}/node/${created.id}`);
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("text/html");
});
