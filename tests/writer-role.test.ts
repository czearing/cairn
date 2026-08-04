import { expect, test, describe } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { claimWriterRole, writerEnv } from "../src/core/writer-role";

// CAIRN_READONLY is a per-process role that the hooks set on themselves, and the hooks are exactly
// what spawn the long-lived writers. Inheriting it made the engine daemon serve every session on the
// machine from a read-only connection, which looked like an outage but was a setting.

describe("writerEnv", () => {
  test("strips the reader role while keeping every other variable", () => {
    const env = writerEnv({ CAIRN_READONLY: "1", CAIRN_ROOT: "/x", PATH: "/usr/bin" });
    expect(env.CAIRN_READONLY).toBeUndefined();
    expect(env).toEqual({ CAIRN_ROOT: "/x", PATH: "/usr/bin" });
  });

  test("is a copy, so clearing the role cannot mutate the parent", () => {
    const source = { CAIRN_READONLY: "1", CAIRN_ROOT: "/x" };
    writerEnv(source);
    expect(source.CAIRN_READONLY).toBe("1");
  });

  test("drops undefined values rather than passing them to spawn", () => {
    const env = writerEnv({ CAIRN_ROOT: "/x", CAIRN_LIBSQL_URL: undefined });
    expect("CAIRN_LIBSQL_URL" in env).toBe(false);
  });

  test("leaves an environment that never had the role untouched", () => {
    expect(writerEnv({ CAIRN_ROOT: "/x" })).toEqual({ CAIRN_ROOT: "/x" });
  });
});

describe("claimWriterRole", () => {
  test("clears an inherited reader role and reports that it did", () => {
    const env = { CAIRN_READONLY: "1", CAIRN_ROOT: "/x" } as NodeJS.ProcessEnv;
    expect(claimWriterRole(env)).toBe(true);
    expect(env.CAIRN_READONLY).toBeUndefined();
    expect(env.CAIRN_ROOT).toBe("/x");
  });

  test("reports false when no role was inherited, and stays idempotent", () => {
    const env = { CAIRN_ROOT: "/x" } as NodeJS.ProcessEnv;
    expect(claimWriterRole(env)).toBe(false);
    expect(claimWriterRole(env)).toBe(false);
    expect(env.CAIRN_ROOT).toBe("/x");
  });

  test("treats any value other than 1 as not a reader role, but still clears it", () => {
    const env = { CAIRN_READONLY: "0" } as NodeJS.ProcessEnv;
    expect(claimWriterRole(env)).toBe(false);
    expect(env.CAIRN_READONLY).toBeUndefined();
  });
});

// End-to-end at the boundary the user actually hits: a process STARTED with CAIRN_READONLY=1 in its
// environment — exactly what a writer spawned by a hook, or launched from a shell that exported the
// flag, inherits. The control child proves the harness reaches the defect (it must fail with the
// read-only error); the writer child proves claimWriterRole repairs it.
describe("a writer started with an inherited reader role", () => {
  const dbUrl = fileURLToPath(new URL("../src/core/db.ts", import.meta.url)).replace(/\\/g, "/");
  const roleUrl = fileURLToPath(new URL("../src/core/writer-role.ts", import.meta.url)).replace(/\\/g, "/");

  async function child(dbPath: string, claim: boolean): Promise<{ code: number; err: string }> {
    const dir = mkdtempSync(join(tmpdir(), "cairn-writer-role-"));
    const script = join(dir, "child.ts");
    writeFileSync(script, [
      claim ? `import { claimWriterRole } from "file://${roleUrl}";` : "",
      claim ? "claimWriterRole();" : "",
      `const { db } = await import("file://${dbUrl}");`,
      `db().run("CREATE TABLE IF NOT EXISTS role_probe (id TEXT PRIMARY KEY)");`,
      `db().run("INSERT OR REPLACE INTO role_probe (id) VALUES ('ok')");`,
    ].join("\n"));
    try {
      const proc = Bun.spawn([process.execPath, script], {
        env: { ...process.env, CAIRN_READONLY: "1", CAIRN_DB_PATH: dbPath, CAIRN_ENGINE_NO_SERVER: "1" },
        stdout: "pipe",
        stderr: "pipe",
      });
      const err = await new Response(proc.stderr).text();
      return { code: await proc.exited, err };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test("writes instead of refusing every write, and the control proves the boundary is real", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cairn-writer-db-"));
    const dbPath = join(dir, "brain.db").replace(/\\/g, "/");
    try {
      const writer = await child(dbPath, true);
      expect(writer.err).not.toContain("read-only");
      expect(writer.code).toBe(0);

      // Only meaningful once the file exists: a missing brain opens as a harmless empty stub.
      const control = await child(dbPath, false);
      expect(control.code).not.toBe(0);
      expect(control.err).toContain("brain is open read-only");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
