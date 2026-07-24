import { expect, test } from "bun:test";
import { rerankConnectedResults } from "../src/core/search-rerank";

test("graph-connected relevant results receive a bounded reranking boost", () => {
  const results = rerankConnectedResults([
    { id: "a", text: "a", answer: "", citation: "", edges: [], score: 0.61 },
    { id: "b", text: "b", answer: "", citation: "", edges: ["c"], score: 0.60 },
    { id: "c", text: "c", answer: "", citation: "", edges: ["b"], score: 0.55 },
  ], 0.1);

  expect(results.map((result) => result.id)).toEqual(["b", "a", "c"]);
  expect(results.every((result) => result.score >= 0 && result.score <= 1)).toBe(true);
});

test("zero graph boost preserves the exact original results", () => {
  const results = [
    { id: "a", text: "a", answer: "", citation: "", edges: ["b"], score: 0.6 },
    { id: "b", text: "b", answer: "", citation: "", edges: ["a"], score: 0.5 },
  ];
  expect(rerankConnectedResults(results, 0)).toBe(results);
});
