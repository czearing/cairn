// Types for the skill pipeline: spawn a cairn-connected Claude (via the local CLI) to grade a finished run
// and rewrite its skill's master prompt.

/** Options for a headless `claude -p` run. */
export interface ClaudeOpts {
  /** Appended to the CLI's system prompt (the reviewable role for the spawned instance). */
  system?: string;
  /** Tools the spawned instance may call, e.g. ["mcp__cairn__brain_search"]. Empty = none. */
  allowedTools?: string[];
  /** Path to an MCP config JSON exposing the cairn brain server. */
  mcpConfigPath?: string;
  /** Extra env for the spawned CLI (and the MCP server it spawns), merged over process.env. */
  env?: Record<string, string>;
  /** Hard timeout for the call; the run is killed and returns ok:false past it. */
  timeoutMs?: number;
  /** Model id for the spawned CLI (e.g. "claude-sonnet-4-6"). Omitted = the CLI's own default. */
  model?: string;
  /** Isolated working directory for benchmark or review fixtures. */
  cwd?: string;
}

/** The reviewer's verdict on one output: a quality score plus what to keep, fix, and improve. */
export interface Review { score: number; right: string; wrong: string; improve: string; raw: string }

/** Result of a CLI run. `ok` is false on any spawn error, timeout, or non-zero exit; `error` then holds the
 *  real reason (stderr, exit code, or timeout). */
export interface ClaudeResult { ok: boolean; text: string; error?: string }

/** A reusable skill: a master prompt for a task family, matched semantically by its `task` text. The
 *  `masterPrompt` is the instructions a doer agent loads (the only part injected). `explanation` is the
 *  rationale (why the best runs beat the weak ones, what excellent looks like) kept for FUTURE REVIEWER
 *  sessions to reference when they refine the skill; it is never injected into a doer agent. */
export interface Skill {
  id: string;
  task: string;
  masterPrompt: string;
  description?: string;
  explanation?: string;
  ts: number;
}

/** One graded run under a skill: the raw run transcript (the process), its quality, and the reviewer's
 *  notes. The field is named `recipe` for the existing db column it maps to. */
export interface SkillRun { id?: number; skillId: string; recipe: string; quality: number; review: string; ts: number }
