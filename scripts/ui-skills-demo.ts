// Dev helper: serve the skills UI on a separate port (4137) against the LIVE brain (or whatever
// CAIRN_DB_PATH points at). It used to seed a hardcoded demo haiku into a throwaway db, but that text
// went stale and was repeatedly mistaken for the real store, so the seeding is gone: this now shows the
// actual skills. Run: bun scripts/ui-skills-demo.ts
import { start } from "../src/ui/server";

const port = Number(process.env.CAIRN_UI_PORT || "4137");
start(port);
console.log(`Cairn skills UI -> http://localhost:${port}/skills  (brain: ${process.env.CAIRN_DB_PATH || "~/.cairn/cairn.db"})`);
