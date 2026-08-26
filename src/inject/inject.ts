import { readFile } from "node:fs/promises";
import type { NormalizedEvent } from "./events.types";
import { matchEvent } from "./matchers";
import { prefsBlock } from "../core/prefs";

// Prompts directory, resolved from this module's URL (repo-root/prompts/).
const PROMPTS_DIR = new URL("../../prompts/", import.meta.url);

// Given a normalized event, return the prompt text to inject (or null for no-op).
// The file is read only on a positive match — the no-match path is allocation-free.
export async function inject(event: NormalizedEvent): Promise<string | null> {
  const match = matchEvent(event);
  let content: string | null = null;
  if (match) {
    try {
      const c = (await readFile(new URL(match.promptFile, PROMPTS_DIR), "utf8")).trim();
      content = c.length > 0 ? c : null;
    } catch {
      content = null;
    }
  }
  // Standing user preferences ride along with the per-turn prompt (UserPromptSubmit ONLY) so they are in
  // front of the model when it writes — never on tool-call events, so no per-action bloat. With no prefs
  // file (the default), prefsBlock() is "" and this is a pure no-op: behavior is byte-identical.
  if (event.kind === "user_message") {
    const prefs = prefsBlock();
    if (prefs) content = content ? `${prefs}\n\n${content}` : prefs;
  }
  return content;
}
