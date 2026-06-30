import { db } from "./db";
import { all } from "./neurons";

// Structural audits over the brain graph. These are deterministic GRAPH facts (root, open branches) — never
// content judgments. The old isClosedQuestion / isListish regexes (which rejected a brain_create by its first
// word and flagged an answer "non-atomic" by counting semicolons/sentences) were removed: judging meaning by
// pattern produced false positives, so atomicity and open-vs-closed are left to the model that writes the node
// (the tool descriptions and the workflow prompt already ask for atomic, open questions).

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
