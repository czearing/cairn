import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

// Runs before any test module (and therefore before src/core/config loads), guaranteeing the
// whole test run uses a throwaway DB. Tests must NEVER be able to touch the real brain.
process.env.CAIRN_DB_PATH = join(tmpdir(), `cairn-test-${randomUUID()}.db`);
