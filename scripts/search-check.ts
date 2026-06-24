// Prints the full ranked top-K for a query through the REAL src/core/search, so we can diff results
// before vs after migration and prove nothing changed. Set CAIRN_DB_PATH + CAIRN_RELATIVE_FLOOR=0.
import { search } from "../src/core/search";
const q = process.argv[2] || "where does cairn store its database by default";
const hits = await search(q);
for (const h of hits.slice(0, 10)) console.log(`${h.score.toFixed(5)}\t${h.id.slice(0, 8)}\t${h.text.slice(0, 56)}`);
console.log("total:", hits.length);
