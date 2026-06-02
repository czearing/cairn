// Optional demo data. Run: bun run seed
// Writes to your configured brain (CAIRN_DB_PATH, else ~/.cairn/cairn.db).

import { create, mutate } from "../src/core/neurons";

const root = await create("Build Cairn: a shared semantic-graph memory for agents.");

const model = await create("What is the minimal neuron data model?", [root.id]);
await mutate(model.id, { answer: "id, text, answer, edges. Status is derived from answer; nothing else stored." });

const search = await create("How does search rank and traverse results?", [root.id]);
await mutate(search.id, {
  answer:
    "Semantic seeds above a relevance threshold; traverse the entire connected subgraph of each; interleave everything into one relevance-ranked list; no limit.",
});

console.log(`Seeded 3 neurons into ${process.env.CAIRN_DB_PATH ?? "~/.cairn/cairn.db"}`);
