import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

export type Assertion =
  | { type: "fileExists"; path: string }
  | { type: "fileEquals"; path: string; expected: string }
  | { type: "jsonEquals"; path: string; expected: unknown }
  | { type: "commandExit"; argv: string[]; expected?: number };

export interface AssertionResult {
  assertionSet: string;
  passed: number;
  total: number;
  failures: string[];
}

export function runAssertions(manifestPath: string, workspace: string): AssertionResult {
  const raw = readFileSync(manifestPath, "utf8");
  const parsed = JSON.parse(raw) as { assertions?: Assertion[] };
  if (!Array.isArray(parsed.assertions) || !parsed.assertions.length) {
    throw new Error("assertion manifest needs at least one assertion");
  }
  const failures: string[] = [];
  const root = resolve(workspace);
  for (const [index, assertion] of parsed.assertions.entries()) {
    const fail = (message: string) => failures.push(`${index + 1}:${assertion.type}:${message}`);
    if (assertion.type === "commandExit") {
      if (!Array.isArray(assertion.argv) || !assertion.argv.length) {
        fail("argv is empty");
        continue;
      }
      const result = Bun.spawnSync(assertion.argv, { cwd: root, stdout: "ignore", stderr: "ignore" });
      if (result.exitCode !== (assertion.expected ?? 0)) fail(`exit ${result.exitCode}`);
      continue;
    }
    const path = resolve(root, assertion.path);
    const fromRoot = relative(root, path);
    if (fromRoot.startsWith("..") || isAbsolute(fromRoot) || !existsSync(path)) {
      fail("file missing");
      continue;
    }
    if (assertion.type === "fileExists") continue;
    const content = readFileSync(path, "utf8");
    if (assertion.type === "fileEquals" && content !== assertion.expected) fail("content differs");
    if (assertion.type === "jsonEquals") {
      try {
        if (JSON.stringify(JSON.parse(content)) !== JSON.stringify(assertion.expected)) {
          fail("JSON differs");
        }
      } catch {
        fail("invalid JSON");
      }
    }
  }
  return {
    assertionSet: createHash("sha256").update(raw).digest("hex").slice(0, 24),
    passed: parsed.assertions.length - failures.length,
    total: parsed.assertions.length,
    failures,
  };
}
