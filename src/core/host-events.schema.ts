// The raw host-event log schema. It lives in its own leaf module because two owners must create it with
// byte-identical DDL: the engine schema (applied to every brain on open) and the read-only fallback
// connection in host-events.ts. Keeping one copy makes schema drift between them impossible.
export const HOST_EVENTS_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS host_events (
    event_key TEXT PRIMARY KEY,
    host TEXT NOT NULL,
    hook_type TEXT NOT NULL,
    session_id TEXT NOT NULL DEFAULT '',
    turn_id TEXT NOT NULL DEFAULT '',
    agent_id TEXT NOT NULL DEFAULT '',
    tool_call_id TEXT NOT NULL DEFAULT '',
    tool_name TEXT NOT NULL DEFAULT '',
    event_timestamp TEXT NOT NULL DEFAULT '',
    raw_json TEXT NOT NULL,
    recorded_ts INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS host_events_session_recorded
    ON host_events(host, session_id, recorded_ts, event_key)`,
  `CREATE INDEX IF NOT EXISTS host_events_tool_call
    ON host_events(host, tool_call_id, hook_type)`,
  `CREATE INDEX IF NOT EXISTS host_events_agent
    ON host_events(host, session_id, agent_id, recorded_ts)`,
] as const;

// Every hook fire of every agent appends its full payload here and nothing ever removed it, so the log
// grew without bound (~4k rows/day once Cairn ran for all agents). Both readers — hostEvents() and the
// prompt-eval evidence query — join a session against telemetry_runs, which telemetry already prunes on
// CAIRN_USAGE_RETENTION_DAYS; reusing that one window keeps the two logs consistent instead of adding a
// second knob, since a session whose telemetry row is gone cannot be evaluated anyway.
export function hostEventsPruneSql(now = Date.now()): string {
  const days = Math.max(1, Number(process.env.CAIRN_USAGE_RETENTION_DAYS || "30"));
  return `DELETE FROM host_events WHERE recorded_ts < ${Math.floor(now - days * 86_400_000)}`;
}
