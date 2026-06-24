// Agent-facing result budgeting for brain_search. The MCP transport rejects a tool result above a
// token ceiling, and an unbounded dump of every relevant node (each carrying a full answer body) can
// blow it — which fails the WHOLE call, so even the top hits are lost. We bound the payload by a
// CHARACTER budget filled most-relevant-first: a relevance-ordered cut, never a fixed top-N count. The
// dropped tail is always the least relevant; the strong head always survives. A single node whose
// answer alone overflows is kept with its answer trimmed to a head snippet (the full text stays one
// click away at its url), so the call still returns something useful instead of erroring outright.

// Appended where an answer was cut, so the agent knows the body is partial. Answers are length-capped
// at write time, so this only clips the marginal last node at the budget boundary; narrowing the query
// ranks that node higher (fewer competitors) and returns it whole.
export const TRUNC_MARK = "… [truncated to fit the result budget; narrow the query to get this node in full]";

// The largest variant of `item` (trimming ONLY its answer, the one unbounded field) whose serialized
// size fits in `room` chars, or null if not even the metadata-with-empty-answer fits. Measures the real
// JSON.stringify length at each step (binary search), so escaping never pushes us over the budget.
function trimAnswer<T extends { answer: string }>(item: T, room: number): T | null {
  if (room <= 0) return null;
  const make = (k: number): T => ({ ...item, answer: k <= 0 ? "" : item.answer.slice(0, k) + TRUNC_MARK });
  if (JSON.stringify(make(0)).length > room) return null; // even an empty-answer item is too big
  let lo = 1, hi = item.answer.length, best = 0; // best = how much of the answer head we can keep
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (JSON.stringify(make(mid)).length <= room) { best = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  return best > 0 ? make(best) : { ...item, answer: TRUNC_MARK }; // mark even a fully-dropped answer
}

/**
 * Fit ranked search hits into a character budget, most-relevant-first.
 *
 * - Relevance-ordered, NOT a fixed count: keep taking the next-best hit until the budget is spent, then
 *   stop. Refine the query to see a different slice (the tool description already tells the agent this).
 * - `budget <= 0` disables the cap and returns every item unchanged.
 * - The first hit (highest relevance) is never silently dropped: if it alone overflows, its answer is
 *   trimmed to fit rather than failing the call.
 *
 * Measures the actual `JSON.stringify(result)` size, so the returned array is guaranteed to serialize
 * within `budget` (the degenerate exception: a single hit whose id/text/url metadata alone exceeds the
 * budget is still returned, since erroring would be strictly worse).
 */
export function fitToBudget<T extends { answer: string }>(items: T[], budget: number): T[] {
  if (budget <= 0 || items.length === 0) return items;
  const out: T[] = [];
  let used = 2; // the enclosing "[" and "]"
  for (const item of items) {
    const sep = out.length ? 1 : 0; // the comma joining this element to the previous one
    const full = JSON.stringify(item).length;
    if (used + sep + full <= budget) { out.push(item); used += sep + full; continue; }
    // This hit overflows the remaining budget. Try to keep it by trimming only its answer body.
    const trimmed = trimAnswer(item, budget - used - sep);
    if (trimmed) out.push(trimmed);
    else if (out.length === 0) out.push({ ...item, answer: "" }); // never error on a genuine top hit
    break; // budget spent; every remaining hit is lower-relevance than what we already kept
  }
  return out;
}
