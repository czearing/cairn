import { expect, test } from "bun:test";
import { config } from "../src/core/config";
import { db } from "../src/core/db";
import { embedModel } from "../src/core/embed";
import { exactVectorCandidates } from "../src/core/vector-index";
import { encodeVector } from "../src/core/vector";
import { prepareVectorIndex } from "../src/core/vector-store";

test("SQLite vector engine returns exact cosine-ranked candidates", () => {
  db().run("DELETE FROM neurons");
  const vectors = [
    { id: "a", vector: [1, 0, 0] },
    { id: "b", vector: [0.8, 0.2, 0] },
    { id: "c", vector: [0, 1, 0] },
  ];
  for (const item of vectors) {
    db().query(`INSERT INTO neurons(id,text,answer,citation,edges,embedding,embedding_model)
      VALUES (?,?,'','','[]',?,?)`).run(item.id, item.id, encodeVector(item.vector), embedModel());
  }
  prepareVectorIndex(embedModel(), 3);
  const previous = config.dbPath;
  expect(previous).toBeTruthy();
  expect(exactVectorCandidates([1, 0, 0], embedModel(), 0.5, 0, 1, 1)?.map((item) => item.id))
    .toEqual(["a", "b"]);
});
