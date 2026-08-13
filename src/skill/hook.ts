import { skillsEnabled } from "../core/config";
import { skillCatalog, visibleSkill } from "./store";
import { skillCatalogSnapshot } from "./catalog";

// Entry points the Claude Code dispatch calls. The skill feature is ON by default; turn it OFF per machine
// with `"skills": false` in ~/.cairn/config.json or CAIRN_SKILLS=0. All are
// best-effort and never throw, and do no work when disabled or when the skill store is empty.

export { skillsEnabled };

export function skillLoad(id: string): { id: string; title: string; description: string; steps: string } | null {
  if (!skillsEnabled() || !id.trim()) return null;
  const skill = visibleSkill(id.trim());
  if (!skill) return null;
  return {
    id: skill.id,
    title: skill.task,
    description: skill.description ?? "",
    steps: skill.masterPrompt,
  };
}

export function skillSelect(ids: string[]): {
  selected: NonNullable<ReturnType<typeof skillLoad>>[];
  noMatch?: boolean;
  catalogSize?: number;
  reason?: "catalog_empty" | "no_match_in_catalog";
  currentCatalog?: ReturnType<typeof skillCatalog>;
  error?: string;
} {
  if (!skillsEnabled()) return { selected: [], error: "skills are disabled" };
  const snapshot = skillCatalogSnapshot();
  const catalogSize = snapshot.catalog.length;
  const references = [...new Set(ids.map((id) => id.trim()).filter(Boolean))];
  if (!references.length) return { selected: [], error: "select at least one skill title or id" };
  if (references.length === 1 && references[0]!.toLowerCase() === "none") {
    // An empty catalog and a genuine absence of matches must never share one result. They demand
    // opposite responses: creating a skill is correct for a real gap and is duplication when the
    // catalog simply failed to arrive. The size is read from the snapshot this call dereferenced,
    // never recomputed, so a concurrent catalog change cannot report a size the caller never saw.
    return {
      selected: [],
      noMatch: true,
      catalogSize,
      reason: catalogSize === 0 ? "catalog_empty" : "no_match_in_catalog",
    };
  }
  const durableIds = references.map((reference) =>
    snapshot.catalog.find((skill) => skill.title.toLowerCase() === reference.toLowerCase())?.id
    ?? reference
  );
  const selected = durableIds.map(skillLoad);
  const missing = references.filter((_reference, index) => !selected[index]);
  if (missing.length) {
    return {
      selected: [],
      catalogSize,
      currentCatalog: snapshot.catalog,
      error: `unknown or unlearned skill titles or ids: ${missing.join(", ")}`,
    };
  }
  return { selected: selected as NonNullable<ReturnType<typeof skillLoad>>[], catalogSize };
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
      addVersion(skill.id, cleanPlan, "Initial reusable plan supplied before the first run.", Date.now());
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
    const { getSkill, setMasterPrompt, addVersion } = await import("./store");
    const s = getSkill(id.trim());
    if (!s) return { ok: false, id, task: "", error: "unknown skill id" };
    const now = Date.now();
    const expl = (explanation ?? "").trim() || s.explanation || "";
    setMasterPrompt(s.id, master, expl);
    addVersion(s.id, master, expl, now); // timeline entry for the manual edit
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
