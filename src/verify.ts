import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// End-to-end smoke test: warm the embedding model, then run the REAL create -> recall -> delete
// path so the user sees proof the brain works, with timings. It runs against a throwaway temp DB
// so it never touches ~/.cairn/cairn.db, and it executes in a child process (see verify()) so the
// parent installer never imports core with the wrong DB path bound.

export interface VerifyResult {
  ok: boolean;
  recalled: boolean;
  warmMs: number;
  smokeMs: number;
  error?: string;
}

// The actual work. ALWAYS forces its own temp DB so isolation holds regardless of inherited env.
// Invoked inside the child process via the hidden `__smoke` CLI command.
export async function smokeMain(): Promise<VerifyResult> {
  const dir = mkdtempSync(join(tmpdir(), "cairn-verify-"));
  process.env.CAIRN_DB_PATH = join(dir, "verify.db");
  let warmMs = 0;
  let smokeMs = 0;
  try {
    // Import AFTER setting the DB path so config binds to the temp DB on first load.
    const warm0 = performance.now();
    const { embed } = await import("./core/embed");
    await embed("warmup"); // forces the model to download/load now, not on the user's first search
    warmMs = Math.round(performance.now() - warm0);

    const smoke0 = performance.now();
    const { create, remove } = await import("./core/neurons");
    const { search } = await import("./core/search");
    const probe = "What does the Cairn install smoke test verify about the brain?";
    const n = await create(probe);
    const hits = await search("cairn install smoke test verification of the brain");
    const recalled = hits.some((h) => h.id === n.id);
    remove(n.id);
    smokeMs = Math.round(performance.now() - smoke0);

    return { ok: recalled, recalled, warmMs, smokeMs };
  } catch (err) {
    return { ok: false, recalled: false, warmMs, smokeMs, error: err instanceof Error ? err.message : String(err) };
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* temp dir cleanup is best-effort */
    }
  }
}

// Run the smoke test in a clean child process and return the parsed result. Keeping it out of
// the installer's process guarantees the temp-DB isolation and a pristine module graph.
export async function verify(): Promise<VerifyResult> {
  const bun = Bun.which("bun") ?? "bun";
  const cli = join(import.meta.dir, "cli.ts");
  const proc = Bun.spawn([bun, cli, "__smoke"], { stdout: "pipe", stderr: "pipe" });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  // The model loader may log to stdout; take the last line that parses as our JSON result.
  for (const ln of out.trim().split("\n").reverse()) {
    try {
      const parsed = JSON.parse(ln) as VerifyResult;
      if (typeof parsed.recalled === "boolean") return parsed;
    } catch {
      /* not the result line */
    }
  }
  return { ok: false, recalled: false, warmMs: 0, smokeMs: 0, error: "smoke test produced no result" };
}
