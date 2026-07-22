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

test("/api/review-jobs exposes queue status", async () => {
  const { clearReviewJobs, enqueueReview } = await import("../src/skill/review-queue");
  clearReviewJobs();
  enqueueReview({ id: "ui-job", skillId: "ui-skill", transcriptPath: "C:\\ui.jsonl", backend: "copilot", now: 123 });
  const res = await fetch(`http://localhost:${server.port}/api/review-jobs`);
  const data = (await res.json()) as { jobs: { id: string; status: string }[] };
  expect(data.jobs).toContainEqual(expect.objectContaining({ id: "ui-job", status: "pending" }));
});

test("/api/skills hides pending skills", async () => {
  const { deleteSkill, putSkill, setSkillMetadata } = await import("../src/skill/store");
  putSkill({ id: "ui-learned", task: "learned", masterPrompt: "1. do the work", ts: 1 }, [1, 0]);
  setSkillMetadata("ui-learned", "learned", "Use for testing that curated learned skills appear in the skill viewer API.");
  putSkill({ id: "ui-pending", task: "pending", masterPrompt: "", ts: 2 }, [0, 1]);
  const res = await fetch(`http://localhost:${server.port}/api/skills`);
  const data = (await res.json()) as { skills: { id: string }[] };
  expect(data.skills.some((skill) => skill.id === "ui-learned")).toBe(true);
  expect(data.skills.some((skill) => skill.id === "ui-pending")).toBe(false);
  deleteSkill("ui-learned");
  deleteSkill("ui-pending");
});

test("/usage serves the local telemetry dashboard and API", async () => {
  const page = await fetch(`http://localhost:${server.port}/usage`);
  expect(page.status).toBe(200);
  expect(await page.text()).toContain("Cairn livesite telemetry");
  const api = await fetch(`http://localhost:${server.port}/api/usage?days=1`);
  expect(api.status).toBe(200);
  const body = await api.json() as { usage?: unknown; quality?: unknown };
  expect(body.usage).toBeDefined();
  expect(body.quality).toBeDefined();
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
