/** A single Claude Code hook command. */
export interface HookEntry {
  type: "command";
  command: string;
}

/** A group of hooks, optionally gated by a tool-name matcher. */
export interface HookGroup {
  matcher?: string;
  hooks: HookEntry[];
}

/** The subset of Claude Code's `settings.json` we read and merge into. */
export interface Settings {
  hooks?: Record<string, HookGroup[]>;
  [key: string]: unknown;
}
