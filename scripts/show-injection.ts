#!/usr/bin/env bun
// Preview the compact catalog an agent receives. Agent-facing skill routing is explicit, not semantic.
import { skillCatalog } from "../src/skill/store";

const query = process.argv.slice(2).join(" ").trim();
if (!query) { console.error('usage: bun scripts/show-injection.ts "<your prompt>"'); process.exit(1); }

console.log(`QUERY: ${query}\n`);
console.log(JSON.stringify({ task: query, catalog: skillCatalog() }, null, 2));
process.exit(0);
