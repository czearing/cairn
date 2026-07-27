import { expect, test } from "bun:test";
import {
  ENGINE_PROTOCOL_VERSION,
  engineFingerprint,
  parseEngineLock,
} from "../src/core/engine-protocol";

const fingerprint = engineFingerprint({
  dbPath: "C:\\brain\\cairn.db",
  model: "model",
});

test("engine lock requires the exact protocol, fingerprint, and a strong token", () => {
  const valid = {
    protocol: ENGINE_PROTOCOL_VERSION,
    port: 43123,
    pid: 123,
    token: "a".repeat(64),
    fingerprint,
    startedAt: Date.now(),
  };
  expect(parseEngineLock(JSON.stringify(valid), fingerprint)).toEqual(valid);
  expect(parseEngineLock(JSON.stringify({ ...valid, protocol: 999 }), fingerprint)).toBeNull();
  expect(parseEngineLock(JSON.stringify({ ...valid, fingerprint: "stale" }), fingerprint)).toBeNull();
  expect(parseEngineLock(JSON.stringify({ ...valid, token: "short" }), fingerprint)).toBeNull();
});

test("engine fingerprint changes with database ownership", () => {
  const changed = engineFingerprint({
    dbPath: "C:\\brain\\other.db",
    model: "model",
  });
  expect(changed).not.toBe(fingerprint);
});
