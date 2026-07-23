// Neighbor context for search results. Instead of shipping a hit's raw edge UUIDs (which the agent
// cannot act on), resolve the two adjacent questions in the brain's reasoning graph and attach them as
// short text: where this thought CAME FROM and where it WENT. That is the recollection signal a flat
// top-K recall misses, at a bounded cost (two short strings per hit, regardless of how many edges the
// node has).
import type { NodeRef } from "../core/neurons";

// First line of a question, trimmed and length-bounded. Questions are single-line by construction, but
// bound anyway so one stray long node can't inflate the context block.
export function firstLine(text: string, max = 140): string {
  const line = (text.split("\n", 1)[0] ?? "").trim();
  return line.length > max ? line.slice(0, max - 1).trimEnd() + "…" : line;
}

/** A hit's adjacent decomposition questions: `prior` = nearest earlier-created neighbor (its parent /
 * the question it came from), `next` = nearest later-created neighbor (a child / where the reasoning
 * went). Direction comes from rowid, since a parent is always created before its child. Bounded to ONE
 * each: a hub node with many edges still adds only two short strings, never its whole neighbor list.
 * Returns {} when the hit or its neighbors are unresolvable. */
export function neighborRefs(
  hit: { id: string; edges: string[] },
  refs: Map<string, NodeRef>,
): { prior?: NodeRef; next?: NodeRef } {
  const self = refs.get(hit.id);
  if (!self) return {};
  let prior: NodeRef | undefined; // nearest neighbor created before the hit
  let next: NodeRef | undefined; // nearest neighbor created after the hit
  for (const e of hit.edges) {
    const r = refs.get(e);
    if (!r) continue;
    if (r.rowid < self.rowid) {
      if (!prior || r.rowid > prior.rowid) prior = r;
    } else if (r.rowid > self.rowid) {
      if (!next || r.rowid < next.rowid) next = r;
    }
  }
  return { prior, next };
}

export function neighborContext(
  hit: { id: string; edges: string[] },
  refs: Map<string, NodeRef>,
): { prior?: string; next?: string } {
  const { prior, next } = neighborRefs(hit, refs);
  const out: { prior?: string; next?: string } = {};
  if (prior) out.prior = firstLine(prior.text);
  if (next) out.next = firstLine(next.text);
  return out;
}
