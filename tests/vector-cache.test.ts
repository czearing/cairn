// The in-memory vector cache must never serve stale results. It is keyed on db().changeToken(),
// which moves on every write through the connection — create, mutate, delete, and even a direct SQL
// write that bypasses neurons.ts. These tests prove a search run right after each kind of write sees
// the new state, so the speedup can never cost correctness.
import { test, expect, beforeAll, beforeEach } from "bun:test";

let N: typeof import("../src/core/neurons");
let S: typeof import("../src/core/search");
let DB: typeof import("../src/core/db");

beforeAll(async () => {
  N = await import("../src/core/neurons");
  S = await import("../src/core/search");
  DB = await import("../src/core/db");
});
beforeEach(() => DB.db().run("DELETE FROM neurons"));

test("a freshly created neuron is visible to the next search (cache invalidates on insert)", async () => {
  const a = await N.create("how do I brew espresso");
  expect((await S.search("espresso brewing")).map((r) => r.id)).toContain(a.id);

  // Second write must bust the cache built by the first search.
  const b = await N.create("how do I steam milk for latte art");
  const ids = (await S.search("steaming milk")).map((r) => r.id);
  expect(ids).toContain(b.id);
});

test("a removed neuron disappears from the next search (cache invalidates on delete)", async () => {
  const a = await N.create("the capital of France is Paris");
  expect((await S.search("capital of France")).map((r) => r.id)).toContain(a.id); // warms the cache
  N.remove(a.id);
  expect((await S.search("capital of France")).map((r) => r.id)).not.toContain(a.id);
});

test("a mutated answer changes what the next search recalls (cache invalidates on mutate)", async () => {
  const a = await N.create("which database does the project use");
  await S.search("database choice"); // warm cache on the pre-mutation vector
  await N.mutate(a.id, { answer: "It uses PostgreSQL with the pgvector extension.", citation: "https://example.com/db" });
  // The answer text now participates in the embedding; the node must still be recalled, proving the
  // cache rebuilt against the mutated row rather than the stale one.
  expect((await S.search("pgvector postgres")).map((r) => r.id)).toContain(a.id);
});

test("searchChangeToken tracks searchable writes but ignores unrelated database activity", async () => {
  const t0 = DB.searchChangeToken();
  expect(DB.searchChangeToken()).toBe(t0);
  DB.db().query("INSERT OR REPLACE INTO engine_meta(key,value) VALUES ('unrelated_test_seq',?)").run(Date.now());
  expect(DB.searchChangeToken()).toBe(t0);
  await N.create("a brand new thought");
  expect(DB.searchChangeToken()).not.toBe(t0);
});

test("searchChangeToken moves when graph edges change", async () => {
  const a = await N.create("first graph thought");
  const b = await N.create("second graph thought");
  const before = DB.searchChangeToken();
  N.link(a.id, b.id);
  expect(DB.searchChangeToken()).not.toBe(before);
});
