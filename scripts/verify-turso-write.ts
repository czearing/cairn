// Validate the full write path in libSQL/cloud mode: create() embeds + write-throughs to the Turso
// primary, get() reads it back, remove() deletes it. Leaves no test data behind.
import { create, get, remove } from "../src/core/neurons";
import { config } from "../src/core/config";

if (!config.libsql.url || !config.libsql.token) throw new Error("set CAIRN_LIBSQL_URL and CAIRN_LIBSQL_TOKEN");
const stamp = process.argv[2] || "x";
const n = await create(`how does the turso write path behave for stamp ${stamp}`);
console.log("created in cloud:", n.id);
const back = get(n.id);
console.log("read back     :", back ? back.text : "MISSING");
const deleted = remove(n.id);
console.log("removed       :", deleted);
console.log(n.id && back && deleted ? "OK write path" : "WARN write path");
