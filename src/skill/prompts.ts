// System prompt for the spawned compaction instance, kept here as the single source of truth so it can
// be reviewed. Compaction needs no brain access (only the reviewer does), so this runs tool-free.

export const COMPACTION_SYSTEM = `You compact one finished conversation into a reusable recipe table.

Output ONLY a markdown table, nothing before or after it:
| timestamp | step | result |

- One row per real step, in order.
- timestamp: from the input, same format.
- step: the action, short and imperative.
- result: what it produced.
- Merge trivial or repeated steps.`;

// The user message for a compaction run: the conversation to compact.
export function compactionUserPrompt(transcript: string): string {
  return `Compact this conversation:\n\n${transcript}`;
}
