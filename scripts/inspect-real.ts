// Read-only investigation of a real brain (point CAIRN_DB_PATH at a COPY). Reports corpus size,
// embedding-vector provenance (dimension spread = model mixing), and how the live search() ranks a
// handful of real queries, including how many neurons clear the relevance threshold.
import { db } from "../src/core/db";
import { all } from "../src/core/neurons";
import { search } from "../src/core/search";
import { embed, cosine } from "../src/core/embed";
import { config } from "../src/core/config";

const rows = db().query("SELECT id, text, answer, embedding FROM neurons").all() as
  { id: string; text: string; answer: string; embedding: string | null }[];

const dims = new Map<number, number>();
let missing = 0;
for (const r of rows) {
  if (!r.embedding) { missing++; continue; }
  let v: number[] | null = null;
  try { v = JSON.parse(r.embedding); } catch { v = null; }
  const d = v ? v.length : -1;
  dims.set(d, (dims.get(d) ?? 0) + 1);
}
console.log(`neurons=${rows.length}  missing-embedding=${missing}`);
console.log(`embedding dimensions present: ${[...dims.entries()].map(([d, c]) => `${d}-dim×${c}`).join(", ")}`);
console.log(`threshold=${config.relevanceThreshold}  model=${config.embed.provider}/${config.embed.model || "(default)"}\n`);

const queries = [
  "how do we improve the quality and accuracy of semantic search results",
  "where does cairn store its database by default",
  "how is the installer tested",
  "what is the best embedding model to use",
  "how do we make the brain shareable across a team",
];

for (const q of queries) {
  const qv = await embed(q);
  const scored = all()
    .map((n) => {
      const r = rows.find((x) => x.id === n.id)!;
      let v: number[] = [];
      try { v = r.embedding ? JSON.parse(r.embedding) : []; } catch { v = []; }
      return { text: n.text, sim: v.length ? cosine(qv, v) : -1 };
    })
    .sort((a, b) => b.sim - a.sim);
  const above = scored.filter((s) => s.sim >= config.relevanceThreshold).length;
  console.log(`Q: ${q}`);
  console.log(`   clear ${config.relevanceThreshold}: ${above}/${scored.length}`);
  for (const s of scored.slice(0, 6)) console.log(`   ${s.sim.toFixed(3)}  ${s.text.slice(0, 84)}`);
  console.log();
}
