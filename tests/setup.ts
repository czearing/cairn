import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

// Runs before any test module (and therefore before src/core/config loads), guaranteeing the
// whole test run uses a throwaway DB. Tests must NEVER be able to touch the real brain.
process.env.CAIRN_DB_PATH = join(tmpdir(), `cairn-test-${randomUUID()}.db`);

// Pin the adaptive relative floor OFF for tests, so the production default (0.7) doesn't change the
// fixed corpora the semantic tests assert against. Tests that exercise the floor set it explicitly.
process.env.CAIRN_RELATIVE_FLOOR = "0";
