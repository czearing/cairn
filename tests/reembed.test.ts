// Vector comparability: a neuron embedded by a DIFFERENT model is incomparable to the current query
// (different space, often different dimension). Search must (1) never score against such a vector
// blindly, and (2) self-heal it by re-embedding with the current model. Guards the silent-garbage
// failure that a model/provider change (e.g. 384-dim MiniLM -> 1536-dim OpenAI) would otherwise cause.
import { test, expect, beforeAll, beforeEach } from "bun:test";
import { decodeVector } from "../src/core/vector";

let N: typeof import("../src/core/neurons");
let S: typeof import("../src/core/search");
let DB: typeof import("../src/core/db");
let E: typeof import("../src/core/embed");

beforeAll(async () => {
  N = await import("../src/core/neurons");
  S = await import("../src/core/search");
  DB = await import("../src/core/db");
  E = await import("../src/core/embed");
});
beforeEach(() => DB.db().run("DELETE FROM neurons"));

test("cosine: a length mismatch is incomparable, not a truncated score", () => {
  // Without the guard this would dot the shared [1] prefix and return 1.0 — a perfect-match lie.
  expect(E.cosine([1, 0, 0], [1, 0])).toBe(-1);
  // Same length still behaves as a normal dot product of unit vectors.
  expect(E.cosine([1, 0], [1, 0])).toBeCloseTo(1, 5);
  expect(E.cosine([1, 0], [0, 1])).toBeCloseTo(0, 5);
});

test("create/mutate stamp the embedding_model that produced the vector", () => {
  // (sync read of the row the public API just wrote)
  return (async () => {
    const n = await N.create("how do I write a haiku poem");
    const row = DB.db().query("SELECT embedding_model FROM neurons WHERE id = ?").get(n.id) as { embedding_model: string };
    expect(row.embedding_model).toBe(E.embedModel());
  })();
});

test("search self-heals a vector left by a different model", async () => {
  const n = await N.create("how do I write a haiku poem");
  // Simulate a vector from another model: wrong dimension AND a stale model id.
  DB.db().query("UPDATE neurons SET embedding = ?, embedding_model = ? WHERE id = ?")
    .run(JSON.stringify([0.1, 0.2, 0.3]), "some-old-model@v0", n.id);

  const res = await S.search("compose a poem");
  expect(res.map((r) => r.id)).toContain(n.id); // recalled despite the stale vector

  const row = DB.db().query("SELECT embedding, embedding_model FROM neurons WHERE id = ?").get(n.id) as
    { embedding: unknown; embedding_model: string };
  expect(row.embedding_model).toBe(E.embedModel());        // re-stamped to the current model
  expect(decodeVector(row.embedding)!.length).toBeGreaterThan(3); // re-embedded to full dim
});

test("search adopts a legacy NULL-labeled vector of the right dimension WITHOUT re-embedding", async () => {
  const n = await N.create("training deep neural networks");
  // A legacy row: vector present and the current dimension, but no model label. Overwrite it with a
  // recognizable sentinel of the SAME length so we can prove the vector was kept, not recomputed.
  const dim = decodeVector((DB.db().query("SELECT embedding FROM neurons WHERE id = ?").get(n.id) as { embedding: unknown }).embedding)!.length;
  const sentinel = Array.from({ length: dim }, (_, i) => (i === 0 ? 1 : 0));
  // Seed it in the LEGACY JSON-string format on purpose — search must still read it and adopt it.
  DB.db().query("UPDATE neurons SET embedding = ?, embedding_model = NULL WHERE id = ?").run(JSON.stringify(sentinel), n.id);

  await S.search("machine learning model training");

  const row = DB.db().query("SELECT embedding, embedding_model FROM neurons WHERE id = ?").get(n.id) as
    { embedding: unknown; embedding_model: string };
  expect(row.embedding_model).toBe(E.embedModel());                 // label stamped
  expect(decodeVector(row.embedding)).toEqual(sentinel);            // vector values kept (not re-embedded)
});

test("search still backfills a missing embedding", async () => {
  const n = await N.create("training deep neural networks");
  DB.db().query("UPDATE neurons SET embedding = NULL, embedding_model = NULL WHERE id = ?").run(n.id);
  const res = await S.search("machine learning model training");
  expect(res.map((r) => r.id)).toContain(n.id);
  const row = DB.db().query("SELECT embedding_model FROM neurons WHERE id = ?").get(n.id) as { embedding_model: string };
  expect(row.embedding_model).toBe(E.embedModel());
});
