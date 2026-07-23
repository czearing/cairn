import { expect, test } from "bun:test";
import type { NodeRef } from "../src/core/neurons";
import type { ScoredResult } from "../src/core/search.types";
import { searchPayload } from "../src/mcp/search-payload";

const hit = (id: string, text: string, edges: string[], answer = "", citation = ""): ScoredResult => ({
  id, text, edges, answer, citation, score: 0.9,
});
const refs = (...nodes: NodeRef[]) => new Map(nodes.map((node) => [node.id, node]));

test("search payload omits only empty optional fields and duplicate neighbor text", () => {
  const hits = [
    hit("root", "What is the root?", ["child"]),
    hit("child", "What follows the root?", ["root", "outside"], "The answer.", "https://example.com"),
  ];
  const payload = searchPayload(hits, refs(
    { id: "root", text: hits[0]!.text, rowid: 1 },
    { id: "child", text: hits[1]!.text, rowid: 2 },
    { id: "outside", text: "What remains outside the result set?", rowid: 3 },
  ));

  expect(payload).toEqual([
    { id: "root", text: "What is the root?", score: 0.9 },
    {
      id: "child",
      text: "What follows the root?",
      score: 0.9,
      answer: "The answer.",
      citation: "https://example.com",
      next: "What remains outside the result set?",
    },
  ]);
  expect(JSON.stringify(payload).length).toBeLessThan(JSON.stringify(hits).length);
});
