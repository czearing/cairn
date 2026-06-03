import { db } from "./db";
import { all } from "./neurons";
import type { Neuron } from "./neurons.types";

// An answer is non-atomic if it reads like a list or a multi-sentence synthesis rather than a
// single fact. Used to detect leaves that should have been split.
export function isListish(answer: string): boolean {
  const a = answer.trim();
  if (!a) return false;
  if (/\n\s*([-*•]|\d+[.)])/.test(a)) return true; // bullet / numbered list
  if (a.includes(";")) return true; // claims welded with a semicolon
  const connectives = (a.match(/\b(so|because|therefore|whereas)\b/gi) || []).length;
  if (connectives >= 2) return true; // chained cause-and-effect, not one fact
  const sentences = (a.match(/[.!?](\s|$)/g) || []).length;
  return sentences > 2 || a.length > 320; // multi-sentence synthesis
}

// A title that opens with a closed interrogative is a yes/no question: it presumes its answer
// and cannot be split. Open questions (how/why/what/which) are required instead.
const CLOSED = /^\s*(do|does|did|is|are|am|was|were|should|can|could|will|would|has|have|had|may|might|must|shall)\b/i;
export function isClosedQuestion(text: string): boolean {
  return CLOSED.test(text);
}

// Answered LEAF nodes whose answer is non-atomic. A leaf has at most one edge (its parent);
// branch nodes (many edges) legitimately hold a synthesis, so they are excluded.
export function unsplitLeaves(): Neuron[] {
  return all().filter((n) => n.edges.length <= 1 && isListish(n.answer));
}

// The earliest-created node — the working root of the current decomposition.
export function rootId(): string | null {
  const r = db().query("SELECT id FROM neurons ORDER BY rowid LIMIT 1").get() as { id: string } | null;
  return r ? r.id : null;
}

// Is there an unanswered node other than the root? (an open branch still to descend)
export function openBranchExists(): boolean {
  const root = rootId();
  return all().some((n) => n.id !== root && !n.answer.trim());
}
