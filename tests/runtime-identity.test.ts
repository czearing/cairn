import { expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { installedReleaseVersion } from "../src/core/runtime-identity";

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
