import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

test("Copilot hook runner fails open when the hook implementation cannot load", () => {
  const runner = join(import.meta.dir, "..", "src", "hosts", "copilot-cli", "hook-runner.ts");
  const result = spawnSync(Bun.which("bun") || "bun", [runner, "pre-tool"], {
    encoding: "utf8",
    input: JSON.stringify({ toolName: "view" }),
    env: {
      ...process.env,
      CAIRN_COPILOT_HOOK_IMPL: "./missing-hook-implementation",
    },
  });

  expect(result.status).toBe(0);
  expect(result.stdout).toBe("{}");
});
