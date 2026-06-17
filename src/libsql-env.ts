// The libSQL/Turso cloud-sync variables, read from the current environment. `cairn install` copies
// whichever of these are set into each host's MCP server registration, so enabling cross-device sync
// on a new machine is "export the vars, run cairn install" — reproducible from the repo, not a
// hand-edited config file. An empty object means no vars were set, i.e. the default local-only brain.
export function libsqlEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of ["CAIRN_LIBSQL_URL", "CAIRN_LIBSQL_TOKEN", "CAIRN_LIBSQL_SYNC_PERIOD"] as const) {
    const v = process.env[key];
    if (v) out[key] = v;
  }
  return out;
}
