// Shows the opt-in relative floor's effect via the REAL search() path. Point CAIRN_DB_PATH at a COPY.
// For each ratio, prints how many results survive per query and that the top match is retained.
import { search } from "../src/core/search";
import { config } from "../src/core/config";

const queries = [
  "where does cairn store its database by default",
  "how is the installer tested",
  "how do we make the brain shareable across a team",
  "what is the best embedding model to use",
];

await search("warm up");                       // migrate/adopt labels once so timings/counts are clean
const f = (x: number) => x.toFixed(3);
for (const q of queries) {
  const line: string[] = [];
  let topText = "";
  for (const ratio of [0, 0.4, 0.5, 0.6, 0.7]) {
    config.relativeFloor = ratio;
    const res = await search(q);
    if (ratio === 0) topText = res[0]?.text ?? "";
    line.push(`r=${ratio}:${res.length}`);
  }
  config.relativeFloor = 0;
  console.log(`Q: ${q}`);
  console.log(`   counts  ${line.join("  ")}`);
  console.log(`   top: ${topText.slice(0, 70)}`);
}
