import { expect, test } from "bun:test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { installedReleaseVersion, healReleaseLabel } from "../src/core/runtime-identity";

test("installed release identity changes without reloading its module", () => {
  const path = join(tmpdir(), `cairn-release-${randomUUID()}.json`);
  const previous = process.env.CAIRN_COPILOT_HOOK_PATH;
  const previousRelease = process.env.CAIRN_RELEASE;
  process.env.CAIRN_COPILOT_HOOK_PATH = path;
  delete process.env.CAIRN_RELEASE;
  try {
    writeFileSync(path, JSON.stringify({ cairnRelease: "0.1.0+before" }));
    expect(installedReleaseVersion("fallback")).toBe("0.1.0+before");
    writeFileSync(path, JSON.stringify({ cairnRelease: "0.1.0+after" }));
    expect(installedReleaseVersion("fallback")).toBe("0.1.0+after");
  } finally {
    if (previous == null) delete process.env.CAIRN_COPILOT_HOOK_PATH;
    else process.env.CAIRN_COPILOT_HOOK_PATH = previous;
    if (previousRelease == null) delete process.env.CAIRN_RELEASE;
    else process.env.CAIRN_RELEASE = previousRelease;
    rmSync(path, { force: true });
  }
});

test("a stale install label is healed to the live checkout revision", () => {
  // The label is written at install time, so a checkout that commits between installs kept stamping
  // telemetry with an old release and split hook/runtime attribution mid-session.
  const path = join(tmpdir(), `cairn-release-heal-${randomUUID()}.json`);
  const previous = process.env.CAIRN_COPILOT_HOOK_PATH;
  const previousRelease = process.env.CAIRN_RELEASE;
  process.env.CAIRN_COPILOT_HOOK_PATH = path;
  delete process.env.CAIRN_RELEASE;
  try {
    writeFileSync(path, JSON.stringify({ cairnRelease: "0.1.0+stale", hooks: { agentStop: ["keep"] } }));
    expect(healReleaseLabel("0.1.0+live")).toBe(true);
    expect(installedReleaseVersion("fallback")).toBe("0.1.0+live");
    // Healing rewrites only the label; the hook wiring must survive untouched.
    expect(JSON.parse(readFileSync(path, "utf8")).hooks).toEqual({ agentStop: ["keep"] });
    // Already current is a no-op, so a turn never rewrites the file for nothing.
    expect(healReleaseLabel("0.1.0+live")).toBe(false);
  } finally {
    if (previous == null) delete process.env.CAIRN_COPILOT_HOOK_PATH;
    else process.env.CAIRN_COPILOT_HOOK_PATH = previous;
    if (previousRelease == null) delete process.env.CAIRN_RELEASE;
    else process.env.CAIRN_RELEASE = previousRelease;
    rmSync(path, { force: true });
  }
});

