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

// Never spawn the embedding sidecar during tests: embed() stays purely in-process, so the suite leaves no
// background server behind.
process.env.CAIRN_EMBED_NO_SERVER = "1";

// Point the concurrent-review coordination files at a throwaway dir so tests never touch ~/.cairn/inflight.
process.env.CAIRN_INFLIGHT_DIR = join(tmpdir(), `cairn-test-inflight-${randomUUID()}`);

// The skill layer is ON by default in production now; the test run keeps it ON so the skill-feature
// tests exercise the real path. The gating tests below toggle CAIRN_SKILLS locally to check both states.
process.env.CAIRN_SKILLS = "1";
process.env.CAIRN_ENFORCE_STOP_GATES ??= "1";
process.env.CAIRN_USAGE = "1";

// Queue behavior is tested synchronously; never leave detached learner supervisors behind from hook fixtures.
process.env.CAIRN_MAX_LEARNERS = "0";
