import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

// Standing user preferences: short, stable style/output rules (e.g. "no em dashes", "be terse") that
// ride along with the per-turn prompt so they are in front of the model when it writes. Stored as a
// plain, hand-editable text file — preferences are CONFIG, not recallable facts, so they live here and
// are injected deterministically rather than going into the semantic brain (where they'd be query-
// dependent and add to the context that gets ignored). Injected ONLY on UserPromptSubmit, never on
// tool-call events, so they never become per-action bloat.

const HEADER = "# Cairn preferences. One per line, injected into every prompt. Keep them short. Lines starting with # are ignored.";

// ~/.cairn/preferences.md, overridable via CAIRN_PREFS_PATH (tests/scripts never touch the real file).
export function prefsPath(): string {
  return process.env.CAIRN_PREFS_PATH || join(homedir(), ".cairn", "preferences.md");
}

// The active preference lines: trimmed, non-empty, comment (#) lines dropped. Unreadable file → none.
export function readPrefs(): string[] {
  const p = prefsPath();
  if (!existsSync(p)) return [];
  try {
    return readFileSync(p, "utf8").split("\n").map((l) => l.trim()).filter((l) => l.length > 0 && !l.startsWith("#"));
  } catch {
    return [];
  }
}

// The block prepended to the per-turn prompt, or "" when there are no preferences (the default for
// every user who hasn't opted in — so injection is a no-op and behavior is unchanged).
export function prefsBlock(): string {
  const lines = readPrefs();
  if (lines.length === 0) return "";
  return "User preferences — honor these in every response:\n" + lines.map((l) => `- ${l}`).join("\n");
}

function write(lines: string[]): void {
  const p = prefsPath();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, HEADER + "\n" + lines.join("\n") + (lines.length ? "\n" : ""));
}

// Append a preference (deduped, trimmed). Returns the new list.
export function addPref(text: string): string[] {
  const lines = readPrefs();
  const t = text.trim();
  if (t && !lines.includes(t)) lines.push(t);
  write(lines);
  return lines;
}

// Remove by 1-based index OR exact text. Returns the new list.
export function removePref(which: string): string[] {
  let lines = readPrefs();
  const n = Number(which);
  if (Number.isInteger(n) && n >= 1 && n <= lines.length) lines.splice(n - 1, 1);
  else lines = lines.filter((l) => l !== which.trim());
  write(lines);
  return lines;
}

export function clearPrefs(): void {
  write([]);
}
