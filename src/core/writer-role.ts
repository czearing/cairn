// CAIRN_READONLY is a per-process ROLE, not a machine setting — yet it lives in the environment, and
// an environment is inherited. The hooks set it on themselves because a hook only ever reads, and the
// hooks are exactly what spawn the long-lived writers (the engine daemon, the embed daemon, the
// auto-updater). Passing `{ ...process.env }` therefore hands a reader's role to a writer, which then
// serves EVERY session on the machine from a read-only connection until it exits — deterministic
// "brain is open read-only" failures that look like an outage but survive restarts, because the flag
// is re-inherited each time. A shell that exports the flag does the same thing to the whole tree.
//
// A writer is a writer by definition. Neither helper below has a legitimate opposite case, so both are
// unconditional rather than configurable.

const FLAG = "CAIRN_READONLY";

/** Environment for a spawned WRITER: everything the parent has, minus the reader role. */
export function writerEnv(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (key === FLAG || value === undefined) continue;
    out[key] = value;
  }
  return out;
}

/** Called by a writer entry point before its first db() open. Returns true when a role was cleared,
 *  so the caller can surface that it was launched by a reader. */
export function claimWriterRole(env: NodeJS.ProcessEnv = process.env): boolean {
  const inherited = env[FLAG] === "1";
  delete env[FLAG];
  return inherited;
}
