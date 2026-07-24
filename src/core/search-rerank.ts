import type { ScoredResult } from "./search.types";

export function rerankConnectedResults(
  results: ScoredResult[],
  boost: number,
): ScoredResult[] {
  if (boost <= 0 || results.length < 2) return results;
  const ids = new Set(results.map((result) => result.id));
  return results.map((result, originalRank) => {
    const degree = result.edges.filter((edge) => ids.has(edge)).length;
    const connectedness = degree / (degree + 1);
    const score = result.score + boost * (1 - result.score) * connectedness;
    return {
      result: { ...result, score: Math.round(Math.min(1, score) * 1000) / 1000 },
      originalRank,
    };
  }).sort((a, b) => b.result.score - a.result.score || a.originalRank - b.originalRank)
    .map(({ result }) => result);
}
