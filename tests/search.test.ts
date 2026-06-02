// Semantic eval — proves search quality. Meaning-based behavior a keyword matcher can't do.
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

const ids = (ns: { id: string }[]) => ns.map((n) => n.id);
const texts = (ns: { text: string }[]) => ns.map((n) => n.text);
const rank = (ns: { id: string }[], id: string) => ns.findIndex((n) => n.id === id);

test("E1 'write a poem' finds haiku, excludes database/UI", async () => {
  const haiku = await N.create("Create me a haiku");
  await N.create("Build the database indexing layer");
  await N.create("What must the UI do?");
  const res = await S.search("how to write a poem");
  expect(ids(res)).toContain(haiku.id);
  expect(rank(res, haiku.id)).toBe(0);
  expect(texts(res).some((t) => t.includes("database"))).toBe(false);
  expect(texts(res).some((t) => t.includes("UI"))).toBe(false);
});

test("E2 'automobile repair' matches car & vehicle, not bread", async () => {
  const car = await N.create("how do I fix my car");
  const vehicle = await N.create("vehicle maintenance schedule");
  await N.create("baking sourdough bread at home");
  const res = await S.search("automobile repair");
  expect(ids(res)).toContain(car.id);
  expect(ids(res)).toContain(vehicle.id);
  expect(texts(res).some((t) => t.includes("bread"))).toBe(false);
});

test("E3 'machine learning training' ranks ML first, excludes pasta", async () => {
  const nn = await N.create("training deep neural networks");
  await N.create("a recipe for pasta carbonara");
  const res = await S.search("machine learning model training");
  expect(res[0]!.id).toBe(nn.id);
  expect(texts(res).some((t) => t.includes("pasta"))).toBe(false);
});

test("E4 unrelated query returns nothing (no false positives)", async () => {
  await N.create("sourdough bread recipe");
  await N.create("grilling the perfect steak");
  expect(await S.search("quantum field theory in physics")).toEqual([]);
});

test("E5 connected neighbor included via the graph even if unrelated", async () => {
  const haiku = await N.create("how to write a haiku");
  const tax = await N.create("my tax filing deadline this year", [haiku.id]);
  const res = await S.search("poem");
  expect(ids(res)).toContain(haiku.id);
  expect(ids(res)).toContain(tax.id);
  expect(rank(res, haiku.id)).toBeLessThan(rank(res, tax.id));
});

test("E6 NO LIMIT — all relevant neurons returned", async () => {
  for (let i = 0; i < 12; i++) await N.create(`a short poem about season number ${i}`);
  expect((await S.search("poetry and verse")).length).toBe(12);
});

test("E7 matches a neuron by its ANSWER text", async () => {
  const n = await N.create("Q: a geography fact");
  await N.mutate(n.id, { answer: "The capital of France is Paris.", citation: "https://en.wikipedia.org/wiki/Paris" });
  expect(ids(await S.search("what is the capital city of France"))).toContain(n.id);
});

test("E8 a hit returns the WHOLE connected tree (grandchildren included)", async () => {
  const a = await N.create("how to write a haiku poem");
  const b = await N.create("my unrelated tax filing deadline", [a.id]);
  const c = await N.create("weekly grocery shopping list", [b.id]);
  const d = await N.create("when to change my car's oil", [c.id]);
  const got = ids(await S.search("compose a poem"));
  for (const id of [a.id, b.id, c.id, d.id]) expect(got).toContain(id);
});

test("E9 results interleaved by relevance, not hop distance", async () => {
  const a = await N.create("writing a beautiful haiku poem");
  const bridge = await N.create("quarterly corporate tax filing", [a.id]);
  const c = await N.create("composing rhyming verse and poetry", [bridge.id]);
  const res = await S.search("how to write poetry");
  expect(ids(res)).toContain(bridge.id);
  expect(rank(res, a.id)).toBeLessThan(rank(res, bridge.id));
  expect(rank(res, c.id)).toBeLessThan(rank(res, bridge.id));
});
