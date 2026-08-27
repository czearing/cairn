#!/usr/bin/env bun
if (process.env.CAIRN_SKIP_HOOKS === "1" || process.env.CAIRN_REVIEWER === "1") {
  process.stdout.write("{}");
  process.exit(0);
}

import { appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

interface HookModule {
  runCopilotHook(): Promise<void>;
}

const hookModule = process.env.CAIRN_COPILOT_HOOK_IMPL || "./hook";

async function run(): Promise<void> {
  try {
    const hook = await import(hookModule) as HookModule;
    await hook.runCopilotHook();
  } catch (error) {
    try {
      appendFileSync(
        join(tmpdir(), "cairn-copilot-hook-errors.log"),
        `[${new Date().toISOString()}] ${error instanceof Error ? error.stack || error.message : String(error)}\n`,
      );
    } catch {
      // The hook must remain fail-open even when diagnostics cannot be written.
    }
    process.stdout.write("{}");
  }
}

await run();
await new Promise<void>((resolve) => process.stdout.write("", () => resolve()));
process.exit(0);
