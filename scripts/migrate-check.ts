// Proves migrating a real legacy brain (all embedding_model=NULL) is cheap: the first search adopts
// labels in place rather than re-embedding every node. Point CAIRN_DB_PATH at a COPY.
import { db } from "../src/core/db";
import { search } from "../src/core/search";
import { embedModel } from "../src/core/embed";

const before = db().query("SELECT COUNT(*) c FROM neurons WHERE embedding_model IS NULL").get() as { c: number };
const total = db().query("SELECT COUNT(*) c FROM neurons").get() as { c: number };
console.log(`total=${total.c}  null-label(before)=${before.c}  model=${embedModel()}`);

const t0 = performance.now();
const r1 = await search("where does cairn store its database by default");
const t1 = performance.now();
const r2 = await search("where does cairn store its database by default");
const t2 = performance.now();

const after = db().query("SELECT COUNT(*) c FROM neurons WHERE embedding_model = ?").get(embedModel()) as { c: number };
const dims = db().query("SELECT embedding FROM neurons WHERE embedding IS NOT NULL LIMIT 1").get() as { embedding: string };
console.log(`1st search (migrating): ${(t1 - t0).toFixed(0)}ms, returned ${r1.length}`);
console.log(`2nd search (warm):      ${(t2 - t1).toFixed(0)}ms, returned ${r2.length}`);
console.log(`labeled current-model(after)=${after.c}/${total.c}  sample-dim=${(JSON.parse(dims.embedding) as number[]).length}`);
console.log(`top result: ${r1[0]?.text}`);
