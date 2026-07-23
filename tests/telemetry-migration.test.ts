import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";

test("legacy usage and quality telemetry migrate into one schema", () => {
  const dbPath = join(tmpdir(), `cairn-telemetry-migration-${randomUUID()}.db`);
  const script = `
    import { Database } from "bun:sqlite";
    const db = new Database(process.env.CAIRN_DB_PATH);
    db.run(\`CREATE TABLE usage_events(
      id INTEGER PRIMARY KEY,event_key TEXT,ts INTEGER,event_kind TEXT,source TEXT,
      host TEXT,session_hash TEXT,turn_seq INTEGER,tool_name TEXT,input_chars INTEGER,
      output_chars INTEGER,context_chars INTEGER,estimated_tokens INTEGER,
      duration_ms INTEGER,item_count INTEGER,success INTEGER)\`);
    db.run(\`CREATE TABLE quality_runs(
      run_id TEXT PRIMARY KEY,host TEXT,session_hash TEXT,turn_seq INTEGER,
      release_fingerprint TEXT,model TEXT,prompt_hash TEXT,catalog_version TEXT,
      started_ts INTEGER,ended_ts INTEGER,injected_tokens INTEGER,completed INTEGER,
      workflow_passed INTEGER,skill_used INTEGER,brain_used INTEGER,stop_nudges INTEGER,
      tool_calls INTEGER,tool_failures INTEGER,status TEXT)\`);
    db.run(\`CREATE TABLE quality_events(
      event_key TEXT PRIMARY KEY,run_id TEXT,host TEXT,session_hash TEXT,turn_seq INTEGER,
      ts INTEGER,kind TEXT,tool_name TEXT,entity_type TEXT,entity_hash TEXT,success INTEGER,
      input_tokens INTEGER,output_tokens INTEGER,duration_ms INTEGER,item_count INTEGER,value INTEGER)\`);
    db.run(\`CREATE TABLE prompt_evaluations(
      evaluation_id TEXT PRIMARY KEY,baseline_prompt_hash TEXT,candidate_prompt_hash TEXT,
      target_set_hash TEXT,accepted INTEGER,token_reduction REAL,safe_token_reduction REAL,
      quality_improvements INTEGER,quality_checks INTEGER,compared_runs INTEGER,created_ts INTEGER)\`);
    const now = Date.now();
    db.query("INSERT INTO quality_runs VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run("run","copilot","session",1,"release","model","prompt","catalog",
        now,now,10,1,1,1,1,0,1,0,"completed");
    db.query("INSERT INTO quality_events VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run("quality","run","copilot","session",1,now,"tool","brain_search",
        "","",1,2,3,4,1,0);
    db.query("INSERT INTO usage_events VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(1,"usage",now,"context","user-prompt","copilot","session",1,"",
        0,0,40,10,0,0,1);
    db.query("INSERT INTO prompt_evaluations VALUES (?,?,?,?,?,?,?,?,?,?,?)")
      .run("evaluation","base","candidate","definition",1,0.5,0.5,1,10,3,now);
    db.close();
    const { telemetryDatabase } = await import("./src/core/telemetry-schema");
    const migrated = telemetryDatabase();
    const tables = migrated.query("SELECT name FROM sqlite_master WHERE type='table'").all();
    console.log(JSON.stringify({
      tables: tables.map((row) => row.name),
      runs: migrated.query("SELECT COUNT(*) AS count FROM telemetry_runs").get().count,
      events: migrated.query("SELECT COUNT(*) AS count FROM telemetry_events").get().count,
      evaluations: migrated.query("SELECT COUNT(*) AS count FROM telemetry_evaluations").get().count,
    }));
  `;
  const result = spawnSync(process.execPath, ["-e", script], {
    cwd: join(import.meta.dir, ".."),
    env: { ...process.env, CAIRN_DB_PATH: dbPath, CAIRN_USAGE: "1" },
  });
  expect(result.status, result.stderr.toString()).toBe(0);
  const migrated = JSON.parse(result.stdout.toString());
  expect(migrated).toMatchObject({ runs: 1, events: 2, evaluations: 1 });
  expect(migrated.tables).toContain("telemetry_runs");
  expect(migrated.tables).toContain("telemetry_events");
  expect(migrated.tables).not.toContain("usage_events");
  expect(migrated.tables).not.toContain("quality_runs");
  expect(migrated.tables).not.toContain("quality_events");
  expect(migrated.tables).not.toContain("prompt_evaluations");
});
