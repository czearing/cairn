import { readFile } from "node:fs/promises";
import type { NormalizedEvent } from "./events.types";
import { matchEvent } from "./matchers";

// Prompts directory, resolved from this module's URL (repo-root/prompts/).
const PROMPTS_DIR = new URL("../../prompts/", import.meta.url);

// Given a normalized event, return the prompt text to inject (or null for no-op).
// The file is read only on a positive match — the no-match path is allocation-free.
export async function inject(event: NormalizedEvent): Promise<string | null> {
  const match = matchEvent(event);
  if (!match) return null;
  try {
    const content = (await readFile(new URL(match.promptFile, PROMPTS_DIR), "utf8")).trim();
    return content.length > 0 ? content : null;
  } catch {
    return null;
  }
}
