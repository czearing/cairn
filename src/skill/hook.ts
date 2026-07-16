import { homedir } from "node:os";
import { join } from "node:path";
import { writeFileSync, mkdirSync } from "node:fs";
import { skillsEnabled } from "../core/config";
import { learnFromTranscript } from "./learn";
import { getSkill, skillCatalog } from "./store";
import { skillCatalogSnapshot } from "./catalog";

// Entry points the Claude Code dispatch calls. The skill feature is ON by default; turn it OFF per machine
// with `"skills": false` in ~/.cairn/config.json or CAIRN_SKILLS=0. All are
// best-effort and never throw, and do no work when disabled or when the skill store is empty.

export { skillsEnabled };

// Debug aid: every turn, dump exactly what was injected (the raw text plus each matched skill and its score)
// to a file so you can inspect it after talking to Claude. ON by default (it is one tiny best-effort write
// per user turn); set CAIRN_SKILL_DEBUG=0 to turn it off. Override the path with CAIRN_SKILL_DEBUG_FILE.
const debugFile = (): string => process.env.CAIRN_SKILL_DEBUG_FILE || join(homedir(), ".cairn", "last-injection.txt");
function writeInjectionDebug(text: string, count: number): void {
  if (process.env.CAIRN_SKILL_DEBUG === "0") return;
  try {
    const path = debugFile();
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, `catalog routing: ${count} learned skill(s)\n\n----- raw injected prompt -----\n${text || "(empty)"}\n`);
  } catch { /* best-effort */ }
}

// No semantic routing runs on user messages. Record only that explicit catalog selection is active.
export async function skillInject(text: string, _sessionId?: string): Promise<string> {
  if (!skillsEnabled() || !text.trim()) return "";
  try { writeInjectionDebug("(semantic routing disabled; agent selects from skill_search catalog)", skillCatalog().length); }
  catch { /* best-effort */ }
  return "";
}

// Agent-facing routing is deliberately non-semantic. Return the same compact title/description catalog.
export function skillSearch(query: string): {
  task: string;
  catalog: ReturnType<typeof skillCatalog>;
  catalogVersion: string;
  loaded?: ReturnType<typeof skillLoad>;
  matches?: { id: string; task: string; steps: string }[];
} {
  const task = query.trim();
  if (!skillsEnabled() || !task) return { task, catalog: [], catalogVersion: "" };
  const snapshot = skillCatalogSnapshot();
  const loadId = task.match(/^load:([0-9a-f-]+)$/i)?.[1];
  if (loadId) return { task, catalog: [], catalogVersion: snapshot.version, loaded: skillLoad(loadId) };
  try {
    const catalog = snapshot.catalog;
    const exact = catalog.find((skill) => skill.title.toLowerCase() === task.toLowerCase());
    const loaded = exact ? skillLoad(exact.id) : null;
    return loaded
      ? { task, catalog, catalogVersion: snapshot.version, loaded, matches: [{ id: loaded.id, task: loaded.title, steps: loaded.steps }] }
      : { task, catalog, catalogVersion: snapshot.version };
  }
  catch { return { task, catalog: [], catalogVersion: snapshot.version }; }
}

export function skillLoad(id: string): { id: string; title: string; description: string; steps: string } | null {
  if (!skillsEnabled() || !id.trim()) return null;
  const skill = getSkill(id.trim());
  if (!skill?.masterPrompt.trim()) return null;
  return {
    id: skill.id,
    title: skill.task,
    description: skill.description ?? "",
    steps: skill.masterPrompt,
  };
}

export function skillSelect(ids: string[], catalogVersion = ""): {
  selected: NonNullable<ReturnType<typeof skillLoad>>[];
  catalogVersion: string;
  currentCatalog?: ReturnType<typeof skillCatalog>;
  error?: string;
} {
  if (!skillsEnabled()) return { selected: [], catalogVersion: "", error: "skills are disabled" };
  const snapshot = skillCatalogSnapshot();
  if (!catalogVersion.trim()) {
    return {
      selected: [],
      catalogVersion: snapshot.version,
      currentCatalog: snapshot.catalog,
      error: "catalogVersion is required; pass the exact version from the injected catalog",
    };
  }
  if (catalogVersion.trim() !== snapshot.version) {
    return {
      selected: [],
      catalogVersion: snapshot.version,
      currentCatalog: snapshot.catalog,
      error: `stale skill catalog version ${catalogVersion.trim()}; current version is ${snapshot.version}`,
    };
  }
  const uniqueIds = [...new Set(ids.map((id) => id.trim()).filter(Boolean))];
  if (!uniqueIds.length) return { selected: [], catalogVersion: snapshot.version, error: "select at least one skill id" };
  const selected = uniqueIds.map(skillLoad);
  const missing = uniqueIds.filter((_id, index) => !selected[index]);
  if (missing.length) {
    return {
      selected: [],
      catalogVersion: snapshot.version,
      currentCatalog: snapshot.catalog,
      error: `unknown or unlearned skill ids: ${missing.join(", ")}`,
    };
  }
  return { selected: selected as NonNullable<ReturnType<typeof skillLoad>>[], catalogVersion: snapshot.version };
}

// New skills must describe a reusable capability with multiple distinct examples and explicitly justify why
// the existing catalog cannot handle them. Pending skills remain hidden until their first successful review.
export async function skillCreate(
  title: string,
  description: string,
  plan: string,
  whyExistingSkillsDoNotFit: string,
): Promise<{ created: boolean; id: string; title: string; error?: string }> {
  const cleanTitle = title.trim();
  const cleanDescription = description.trim();
  const cleanPlan = plan.trim();
  if (!skillsEnabled()) return { created: false, id: "", title: cleanTitle, error: "skills are disabled" };
  if (!cleanTitle || cleanTitle.split(/\s+/).length > 4) return { created: false, id: "", title: cleanTitle, error: "title must be 1-4 words" };
  if (cleanDescription.length < 80) return { created: false, id: "", title: cleanTitle, error: "description must clearly state when the reusable capability should be used" };
  if (cleanPlan.split("\n").filter((line) => /^\d+\.\s+\S/.test(line.trim())).length < 2) return { created: false, id: "", title: cleanTitle, error: "plan must contain at least two numbered reusable steps" };
  if (whyExistingSkillsDoNotFit.trim().length < 30) return { created: false, id: "", title: cleanTitle, error: "explain why the existing catalog does not fit" };
  try {
    const { categorize } = await import("./match");
    const { addVersion, setMasterPrompt, setSkillMetadata } = await import("./store");
    const { skill, created } = await categorize(cleanTitle, Date.now());
    if (created || !skill.masterPrompt.trim()) {
      setSkillMetadata(skill.id, cleanTitle, cleanDescription);
      setMasterPrompt(skill.id, cleanPlan, "Initial reusable plan supplied before the first run.");
      addVersion(skill.id, cleanPlan, "Initial reusable plan supplied before the first run.", 0, Date.now());
      try { const { reindexSkill } = await import("./match"); await reindexSkill(skill.id, cleanTitle, cleanPlan); } catch { /* catalog routing does not depend on vectors */ }
    }
    return { created, id: skill.id, title: skill.task };
  } catch (error) {
    return { created: false, id: "", title: cleanTitle, error: error instanceof Error ? error.message : String(error) };
  }
}

// Agent-facing skill refinement (the skill_edit MCP tool). Lets the agent rewrite a skill's master prompt
// directly — e.g. right after the user corrects it — folding the fix in IMMEDIATELY instead of waiting for
// the background grader. Records a new version and reindexes retrieval. No-op-safe when the skill layer is off
// or the id is unknown.
export async function skillEdit(id: string, master: string, explanation?: string): Promise<{ ok: boolean; id: string; task: string; error?: string }> {
  if (!skillsEnabled()) return { ok: false, id, task: "", error: "skills are disabled" };
  if (!id.trim()) return { ok: false, id, task: "", error: "id is required" };
  if (!master.trim()) return { ok: false, id, task: "", error: "master is required" };
  try {
    const { getSkill, setMasterPrompt, addVersion, topRuns } = await import("./store");
    const s = getSkill(id.trim());
    if (!s) return { ok: false, id, task: "", error: "unknown skill id" };
    const now = Date.now();
    const expl = (explanation ?? "").trim() || s.explanation || "";
    setMasterPrompt(s.id, master, expl);
    addVersion(s.id, master, expl, topRuns(s.id, 1)[0]?.quality ?? 0, now); // timeline entry for the manual edit
    try { const { reindexSkill } = await import("./match"); await reindexSkill(s.id, s.task, master); } catch { /* embedder down: keep the existing vector */ }
    return { ok: true, id: s.id, task: s.task };
  } catch (e) { return { ok: false, id, task: "", error: e instanceof Error ? e.message : String(e) }; }
}

// True only when the skill layer is on AND at least one skill exists, so the search-first reminder never fires
// on a fresh/empty store (there would be nothing to find).
export function skillsExist(): boolean {
  if (!skillsEnabled()) return false;
  try { return skillCatalog().length > 0; } catch { return false; }
}

// Fire the background learner over a finished turn's transcript, for the skill the agent DECLARED via
// skill_review. `skillId` is the id of that skill (from skill_search or skill_create). Returns whether it fired.
export function skillLearn(transcriptPath: string | undefined, skillId: string): boolean {
  if (!skillsEnabled() || !transcriptPath || !skillId.trim()) return false;
  process.env.CAIRN_LEARN_BACKEND = "claude"; // Claude host: parse the Claude transcript AND grade via `claude -p`
  try { return learnFromTranscript(transcriptPath, skillId); } catch { return false; }
}
