// End-to-end check that the cloud brain works through Cairn's real code path. Point CAIRN_LIBSQL_LOCAL
// at a FRESH file to simulate a brand-new device: db() opens the libSQL replica, pulls from the
// primary, and search() runs the actual semantic pipeline against the synced data.
//
//   CAIRN_LIBSQL_URL=… CAIRN_LIBSQL_TOKEN=… CAIRN_LIBSQL_LOCAL=/tmp/dev2.db bun scripts/verify-turso.ts "your query"
import { db } from "../src/core/db";
import { search } from "../src/core/search";
import { config } from "../src/core/config";

if (!config.libsql.url || !config.libsql.token) throw new Error("set CAIRN_LIBSQL_URL and CAIRN_LIBSQL_TOKEN");
console.log("replica file:", config.libsql.localPath);

const count = (db().query("SELECT COUNT(*) AS n FROM neurons").get() as { n: number }).n;
const embedded = (db().query("SELECT COUNT(*) AS n FROM neurons WHERE embedding IS NOT NULL").get() as { n: number }).n;
console.log(`pulled from cloud: ${count} neurons (${embedded} with embeddings)`);

const q = process.argv[2] || "where does cairn store its database by default";
const hits = await search(q);
console.log(`\nsearch(${JSON.stringify(q)}) -> ${hits.length} hits`);
for (const h of hits.slice(0, 6)) console.log(`  ${h.score.toFixed(3)}  ${h.text.slice(0, 72)}`);
console.log(count > 0 && hits.length > 0 ? "\nOK end-to-end" : "\nWARN: empty result");
