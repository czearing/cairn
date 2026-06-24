// Pure unit tests for the brain_search output budget. No db / no model spawn: just the fit logic that
// keeps an oversized result from blowing the transport token ceiling (which would fail the whole call).
import { test, expect } from "bun:test";
import { fitToBudget, TRUNC_MARK } from "../src/mcp/budget";

type Hit = { id: string; text: string; answer: string; score: number; url: string };

// A hit ranked by `score` (1 = most relevant), with an answer body of `bodyLen` chars.
const hit = (i: number, score: number, bodyLen: number): Hit => ({
  id: `id-${i}`,
  text: `question ${i}`,
  answer: "x".repeat(bodyLen),
  score,
  url: `http://localhost:3737/node/id-${i}`,
});

const size = (xs: unknown) => JSON.stringify(xs).length;

test("budget <= 0 is a no-op: every hit passes through unchanged", () => {
  const hits = [hit(1, 0.9, 100), hit(2, 0.8, 100)];
  expect(fitToBudget(hits, 0)).toEqual(hits);
  expect(fitToBudget(hits, -1)).toEqual(hits);
});

test("a budget larger than the payload returns every hit", () => {
  const hits = [hit(1, 0.9, 100), hit(2, 0.8, 100), hit(3, 0.7, 100)];
  const out = fitToBudget(hits, size(hits) + 10);
  expect(out).toEqual(hits);
});

test("drops the least-relevant tail (relevance order), staying within budget", () => {
  // Five equal-size hits; budget that fits ~3 of them. The two lowest-score hits must be the ones cut.
  const hits = [hit(1, 0.95, 500), hit(2, 0.9, 500), hit(3, 0.85, 500), hit(4, 0.8, 500), hit(5, 0.75, 500)];
  const one = size([hits[0]]);
  const budget = one * 3; // room for roughly three whole hits
  const out = fitToBudget(hits, budget);

  expect(size(out)).toBeLessThanOrEqual(budget); // never overflows
  expect(out.length).toBeGreaterThan(0);
  expect(out.length).toBeLessThan(hits.length); // some were cut
  // kept hits are a strict best-first prefix: no lower-ranked hit survives while a higher-ranked is gone
  const keptIds = out.map((h) => h.id);
  expect(keptIds).toEqual(hits.slice(0, out.length).map((h) => h.id));
});

test("a single hit whose answer overflows is kept, with its answer trimmed and url intact", () => {
  const big = hit(1, 0.95, 50_000);
  const budget = 2_000;
  const out = fitToBudget([big], budget);

  expect(out).toHaveLength(1);
  expect(size(out)).toBeLessThanOrEqual(budget);
  expect(out[0]!.id).toBe(big.id);
  expect(out[0]!.url).toBe(big.url); // metadata preserved
  expect(out[0]!.answer.length).toBeLessThan(big.answer.length); // body was cut
  expect(out[0]!.answer.endsWith(TRUNC_MARK)).toBe(true); // and marked as partial
});

test("the top hit is trimmed (not dropped) so a real match never yields an empty result", () => {
  // First hit overflows even alone; it must still come back (trimmed), never an empty array.
  const hits = [hit(1, 0.95, 100_000), hit(2, 0.9, 100)];
  const out = fitToBudget(hits, 1_500);
  expect(out.length).toBeGreaterThanOrEqual(1);
  expect(out[0]!.id).toBe("id-1");
  expect(size(out)).toBeLessThanOrEqual(1_500);
});

test("preserves arbitrary fields (e.g. score) on kept hits", () => {
  const hits = [hit(1, 0.91, 50)];
  const out = fitToBudget(hits, size(hits) + 5);
  expect(out[0]!.score).toBe(0.91);
});
