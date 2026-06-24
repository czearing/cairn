const { search } = await import("../src/core/search");
let t = performance.now();
const r1 = await search("how does cairn store its database");
console.log("COLD search:", (performance.now()-t).toFixed(0), "ms |", r1.length, "results");
t = performance.now();
const r2 = await search("what is the embedding model");
console.log("WARM search:", (performance.now()-t).toFixed(0), "ms |", r2.length, "results");
