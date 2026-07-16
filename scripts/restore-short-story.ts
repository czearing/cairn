// One-shot: restore the "short story" skill the live db lost (db regressed to an older snapshot).
// Master + explanation come from ~/.cairn/skills-backup.json (06-27, the 0.88 version, 7334 chars).
// The run history is not in that backup, so reconstruct the 6 graded rounds from story-loop.log.
// Additive: "short story" is absent from the live db, so nothing is clobbered. Re-embeds so it is
// retrievable and renders in the /skills viewer.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getSkill, setMasterPrompt, addRun } from "../src/skill/store";
import { categorize, reindexSkill } from "../src/skill/match";

const home = homedir();
const backup = JSON.parse(readFileSync(join(home, ".cairn", "skills-backup.json"), "utf8")) as
  { skills?: any[] } | any[];
const arr = Array.isArray(backup) ? backup : backup.skills ?? [];
const ss = arr.find((s: any) => s.task === "short story");
if (!ss) throw new Error("short story not found in skills-backup.json");

const master: string = ss.master_prompt ?? ss.masterPrompt ?? "";
const explanation: string = ss.explanation ?? "";

if (getSkill(ss.id)) { console.log("short story already present, skipping insert"); }
else {
  // Mint via categorize so the label-normalized restore key is registered, then set master+explanation.
  const { skill } = await categorize("short story", Date.now());
  setMasterPrompt(skill.id, master, explanation);
  // Build the rich retrieval vector from task+master (same path the learner uses).
  await reindexSkill(skill.id, "short story", master);

  // Reconstruct runs from the loop log: each {event:"round"} line is one graded run.
  const logPath = join(home, ".cairn", "story-loop.log");
  const rounds = readFileSync(logPath, "utf8").split("\n").filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter((o) => o && o.event === "round") as any[];
  for (const r of rounds) {
    addRun({ skillId: skill.id, recipe: String(r.story ?? "").slice(0, 4000), quality: Number(r.score) || 0, review: `round ${r.round}, master ${r.masterChars} chars`, ts: 1000 + Number(r.round) });
  }
  console.log(`restored "short story": master ${master.length} chars, ${rounds.length} runs (${rounds.map((r) => r.score).join(", ")})`);
}
