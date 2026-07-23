import type { NodeRef } from "../core/neurons";
import type { ScoredResult } from "../core/search.types";
import { firstLine, neighborRefs } from "./context";

export function searchPayload(hits: ScoredResult[], refs: Map<string, NodeRef>) {
  const returnedIds = new Set(hits.map(({ id }) => id));
  return hits.map((hit) => {
    const result: {
      id: string;
      text: string;
      score: number;
      answer?: string;
      citation?: string;
      prior?: string;
      next?: string;
    } = { id: hit.id, text: hit.text, score: hit.score };
    if (hit.answer) result.answer = hit.answer;
    if (hit.citation) result.citation = hit.citation;
    const { prior, next } = neighborRefs(hit, refs);
    if (prior && !returnedIds.has(prior.id)) result.prior = firstLine(prior.text);
    if (next && !returnedIds.has(next.id)) result.next = firstLine(next.text);
    return result;
  });
}
