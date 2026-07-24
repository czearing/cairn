import type { RuntimeIdentity } from "./runtime-identity";
import { telemetryDatabase } from "./telemetry-schema";

export function correlatedTransportRuntime(input: {
  runId: string;
  host: string;
  sessionHash: string;
  turnSeq: number;
  runClass: string;
  toolName: string;
  inputChars: number;
  outputChars: number;
  success: boolean;
}): RuntimeIdentity | null {
  try {
    const db = telemetryDatabase();
    if (!db) return null;
    const now = Date.now();
    const match = db.query(`SELECT event_key,release_fingerprint,version
      FROM telemetry_events WHERE run_id='' AND kind='tool_transport' AND source='mcp'
        AND tool_name=? AND input_chars=? AND output_chars=? AND success=? AND ts BETWEEN ? AND ?
      ORDER BY ABS(ts-?) LIMIT 1`).get(
        input.toolName, input.inputChars, input.outputChars, Number(input.success),
        now - 60_000, now + 1_000, now,
      ) as { event_key: string; release_fingerprint: string; version: string } | null;
    if (!match?.version || !match.release_fingerprint) return null;
    db.query(`UPDATE telemetry_events SET run_id=?,host=?,session_hash=?,turn_seq=?,run_class=?
      WHERE event_key=? AND run_id=''`).run(
        input.runId, input.host, input.sessionHash, input.turnSeq, input.runClass, match.event_key,
      );
    return { version: match.version, releaseFingerprint: match.release_fingerprint };
  } catch {
    return null;
  }
}
