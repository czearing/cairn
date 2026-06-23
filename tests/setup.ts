import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

// Runs before any test module (and therefore before src/core/config loads), guaranteeing the
// whole test run uses a throwaway DB. Tests must NEVER be able to touch the real brain.
process.env.CAIRN_DB_PATH = join(tmpdir(), `cairn-test-${randomUUID()}.db`);

// Point the sync config file at a nonexistent temp path so tests never pick up a real
// ~/.cairn/config.json (which would flip them into cloud mode). Tests run pure-local bun:sqlite.
process.env.CAIRN_CONFIG_PATH = join(tmpdir(), `cairn-test-noconfig-${randomUUID()}.json`);

// Pin the adaptive relative floor OFF for tests, so the production default (0.7) doesn't change the
// fixed corpora the semantic tests assert against. Tests that exercise the floor set it explicitly.
process.env.CAIRN_RELATIVE_FLOOR = "0";

// Point user preferences at a nonexistent temp path so tests never read or write the real
// ~/.cairn/preferences.md. Prefs tests override this per-test with their own temp file.
process.env.CAIRN_PREFS_PATH = join(tmpdir(), `cairn-test-noprefs-${randomUUID()}.md`);
