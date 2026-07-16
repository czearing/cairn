import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { db } from "../src/core/db";
import { embedModel } from "../src/core/embed";
import { addEdge, edgesFrom } from "../src/core/graph";
import { recordHostEvent, hostEvents } from "../src/core/host-events";
import { encodeVector } from "../src/core/vector";
import {
  activeVectorIndex,
  prepareVectorIndex,
  writeNeuronVector,
} from "../src/core/vector-store";

test("engine pragmas and covering indexes are active", () => {
  expect((db().query("PRAGMA synchronous").get() as { synchronous: number }).synchronous).toBe(1);
  expect((db().query("PRAGMA temp_store").get() as { temp_store: number }).temp_store).toBe(2);
  const edgePlan = db().query(`EXPLAIN QUERY PLAN
    SELECT source_id FROM neuron_edges WHERE target_id = ? AND relation_type = ?`)
    .all("x", "related") as { detail: string }[];
  expect(edgePlan.some((row) => row.detail.includes("neuron_edges_target"))).toBe(true);
  const eventPlan = db().query(`EXPLAIN QUERY PLAN
    SELECT event_key FROM host_events
    WHERE host = ? AND session_id = ? ORDER BY recorded_ts,event_key`)
    .all("copilot", "s") as { detail: string }[];
  expect(eventPlan.some((row) => row.detail.includes("host_events_session_recorded"))).toBe(true);
});

test("neuron and vector writes roll back as one transaction", () => {
  db().run("DELETE FROM neurons");
  const vector = encodeVector([1, 0, 0]);
  prepareVectorIndex(embedModel(), 3);
  expect(() => db().transaction(() => {
    db().query(`INSERT INTO neurons(
      id,text,answer,citation,edges,embedding,embedding_model
    ) VALUES ('rollback','q','','','[]',?,?)`).run(vector, embedModel());
    writeNeuronVector("rollback", embedModel(), vector);
    throw new Error("rollback");
  })).toThrow("rollback");
  expect(db().query("SELECT id FROM neurons WHERE id = 'rollback'").get()).toBeNull();
  const state = activeVectorIndex()!;
  expect(db().query(`SELECT id FROM "${state.tableName}" WHERE id = 'rollback'`).get()).toBeNull();
});

test("relational edges preserve exact ids and provenance without text parsing", () => {
  db().run("DELETE FROM neurons");
  for (const id of ["source", "target:with punctuation"]) {
    db().query(`INSERT INTO neurons(id,text,answer,citation,edges)
      VALUES (?,?,'','','[]')`).run(id, id);
  }
  addEdge("source", "target:with punctuation", "test-source");
  expect(edgesFrom("source")).toEqual(["target:with punctuation"]);
  expect(db().query(`SELECT provenance FROM neuron_edges
    WHERE source_id = ? AND target_id = ?`).get("source", "target:with punctuation"))
    .toEqual({ provenance: "test-source" });
});

test("legacy JSON edges migrate losslessly on database open", () => {
  const path = join(tmpdir(), `cairn-legacy-edges-${randomUUID()}.db`);
  const seed = new Database(path);
  seed.run(`CREATE TABLE neurons(
    id TEXT PRIMARY KEY,text TEXT NOT NULL,answer TEXT NOT NULL DEFAULT '',
    citation TEXT NOT NULL DEFAULT '',edges TEXT NOT NULL DEFAULT '[]',
    embedding BLOB,embedding_model TEXT
  )`);
  seed.query("INSERT INTO neurons(id,text,edges) VALUES ('a','A',?)")
    .run(JSON.stringify(["b", "literal.*[]"]));
  seed.close();
  const result = spawnSync(process.execPath, ["-e", `
    import { db } from ${JSON.stringify(join(import.meta.dir, "..", "src", "core", "db.ts"))};
    console.log(JSON.stringify(db().query(
      "SELECT target_id AS target FROM neuron_edges WHERE source_id='a' ORDER BY position"
    ).all()));
  `], { env: { ...process.env, CAIRN_DB_PATH: path, CAIRN_READONLY: "" } });
  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout.toString())).toEqual([
    { target: "b" },
    { target: "literal.*[]" },
  ]);
});

test("raw host event indexing is byte-preserving and idempotent", () => {
  db().run("DELETE FROM host_events");
  const raw = '{"sessionId":"s","turnId":"t","timestamp":42,"toolCallId":"c","toolName":"task","prompt":"a.*[]"}';
  const payload = JSON.parse(raw);
  const first = recordHostEvent("copilot", "pre-tool", raw, payload, 100);
  const second = recordHostEvent("copilot", "pre-tool", raw, payload, 200);
  expect(second).toBe(first);
  expect(hostEvents("copilot", "s")).toEqual([
    expect.objectContaining({
      eventKey: first,
      turnId: "t",
      toolCallId: "c",
      toolName: "task",
      eventTimestamp: "42",
      rawJson: raw,
      recordedTs: 100,
    }),
  ]);
});

test("immediate transactions preserve every concurrent writer", async () => {
  const path = join(tmpdir(), `cairn-concurrent-writes-${randomUUID()}.db`);
  const seed = new Database(path);
  seed.run("PRAGMA journal_mode=WAL");
  seed.run("CREATE TABLE writes(id TEXT PRIMARY KEY)");
  seed.close();
  const script = `
    import { db } from ${JSON.stringify(join(import.meta.dir, "..", "src", "core", "db.ts"))};
    const prefix=process.env.WRITER_PREFIX;
    for(let i=0;i<25;i++) db().transaction(()=>{
      db().query("SELECT COUNT(*) AS n FROM writes").get();
      db().query("INSERT INTO writes(id) VALUES (?)").run(prefix+":"+i);
    });
  `;
  const children = Array.from({ length: 4 }, (_, index) => Bun.spawn([
    process.execPath, "-e", script,
  ], {
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      CAIRN_DB_PATH: path,
      CAIRN_READONLY: "",
      WRITER_PREFIX: `writer-${index}`,
    },
  }));
  const results = await Promise.all(children.map(async (child) => ({
    code: await child.exited,
    error: await new Response(child.stderr).text(),
  })));
  expect(results).toEqual(results.map(() => ({ code: 0, error: "" })));
  const verify = new Database(path);
  expect((verify.query("SELECT COUNT(*) AS n FROM writes").get() as { n: number }).n).toBe(100);
  verify.close();
});
