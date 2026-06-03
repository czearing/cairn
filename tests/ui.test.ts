import { test, expect, beforeAll, afterAll } from "bun:test";

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

test("/api/search returns ranked results", async () => {
  const res = await fetch(`http://localhost:${server.port}/api/search?q=viewer%20test`);
  const data = (await res.json()) as { results: { id: string }[] };
  expect(Array.isArray(data.results)).toBe(true);
  expect(data.results.some((n) => n.id === created.id)).toBe(true);
});

test("serves the app.js asset", async () => {
  const res = await fetch(`http://localhost:${server.port}/app.js`);
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("javascript");
});

test("write endpoints: create, edit, link/unlink, delete", async () => {
  const base = `http://localhost:${server.port}`;
  const j = (r: Response) => r.json() as Promise<any>;
  const post = (p: string, body: object) =>
    fetch(base + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const patch = (id: string, body: object) =>
    fetch(`${base}/api/neurons/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

  const a = (await j(await post("/api/neurons", { text: "editable" }))).neuron;
  expect(a.id).toBeTruthy();
  expect((await j(await patch(a.id, { text: "edited" }))).neuron.text).toBe("edited");
  expect((await patch(a.id, { answer: "uncited" })).status).toBe(400); // citation enforced

  const b = (await j(await post("/api/neurons", { text: "other" }))).neuron;
  await post("/api/link", { a: a.id, b: b.id });
  const all = (await j(await fetch(base + "/api/neurons"))).neurons;
  expect(all.find((n: any) => n.id === a.id).edges).toContain(b.id);
  expect(all.find((n: any) => n.id === b.id).edges).toContain(a.id); // mirrored

  await post("/api/unlink", { a: a.id, b: b.id });
  expect((await j(await fetch(`${base}/api/neurons`))).neurons.find((n: any) => n.id === a.id).edges).not.toContain(b.id);

  expect((await j(await fetch(`${base}/api/neurons/${a.id}`, { method: "DELETE" }))).deleted).toBe(true);
});
