// Structural detection of host/system "envelopes" that the harness delivers AS a user message but which are
// NOT a human prompt: the host's own notification and reminder wrappers, a skill-context preamble, and slash-
// command framing. extractRun{,Copilot} use this to skip such messages when scoping a turn and building its
// request, so a background-task notification or a system reminder can never become "the task" the skill loop
// grades and mints a skill from.
//
// This is a STRUCTURAL event filter — the same kind that already drops Claude tool-result frames — keyed on
// the host's literal, self-owned wrapper tags. It is NOT a content/quality judgment: deciding whether genuine
// work is a reusable deliverable stays entirely with the segmenter (an LLM). We match only the harness's
// stable wrapper tags here; cairn's own injected brain/workflow reminders are plain prose and are left to the
// segmenter to recognize, so this list never has to track prompt wording.
const ENVELOPE_PREFIXES = [
  "<cairn-internal",
  "<task-notification",
  "<system_notification",
  "<system_reminder",
  "<system-reminder",
  "<skill-context",
  "<command-message",
  "<command-name",
];

/** True when `text` is a host/system envelope (it BEGINS with one of the harness's wrapper tags), so it should
 *  not be treated as a human prompt. Whitespace-insensitive at the start; empty/non-envelope text is false. */
export function isSystemEnvelope(text: string): boolean {
  const t = text.trimStart().toLowerCase();
  return ENVELOPE_PREFIXES.some((p) => t.startsWith(p));
}
