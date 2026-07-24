export type TelemetryHost = "copilot" | "claude";

export interface TelemetryRunIdentity {
  host: TelemetryHost;
  sessionId: string;
  turnSeq: number;
}

export interface TelemetryEvent {
  kind: "context" | "tool_transport";
  source: string;
  host?: string;
  sessionId?: string;
  turnSeq?: number;
  toolName?: string;
  inputChars?: number;
  outputChars?: number;
  contextChars?: number;
  durationMs?: number;
  itemCount?: number;
  success?: boolean;
  eventKey?: string;
  releaseFingerprint?: string;
  version?: string;
  runClass?: "human" | "benchmark" | "worker";
  ts?: number;
}
