// Types for the skill pipeline: spawn a cairn-connected Claude (via the local CLI) to compact one
// finished conversation into a reusable recipe table.

/** One compacted step of a conversation. */
export interface CompactRow { timestamp: string; step: string; result: string }

/** Options for a headless `claude -p` run. */
export interface ClaudeOpts {
  /** Appended to the CLI's system prompt (the reviewable role for the spawned instance). */
  system?: string;
  /** Tools the spawned instance may call, e.g. ["mcp__cairn__brain_search"]. Empty = none. */
  allowedTools?: string[];
  /** Path to an MCP config JSON exposing the cairn brain server. */
  mcpConfigPath?: string;
  /** Hard timeout for the call; the run is killed and returns ok:false past it. */
  timeoutMs?: number;
}

/** Result of a CLI run. `ok` is false on any spawn error, timeout, or non-zero exit. */
export interface ClaudeResult { ok: boolean; text: string }
