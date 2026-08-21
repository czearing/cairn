import { createHash } from "node:crypto";
import { skillCatalogDetails, visibleSkill, type SkillCatalogEntry } from "./store";

interface SkillCatalogSnapshot {
  version: string;
  catalog: SkillCatalogEntry[];
}

export function skillCatalogSnapshot(): SkillCatalogSnapshot {
  const details = skillCatalogDetails();
  const version = createHash("sha256").update(JSON.stringify(details)).digest("hex");
  return {
    version,
    catalog: details.map(({ masterPrompt: _masterPrompt, ...entry }) => entry),
  };
}

export function formatSkillCatalog(mode: "full" | "titles" = "titles"): string {
  const snapshot = skillCatalogSnapshot();
  const rows = snapshot.catalog.map((skill) => mode === "titles"
    ? skill.title
    : `- **${skill.title}**: ${skill.description}`);
  return `## Available skill catalog\nPass exact titles to \`skill_select\`.\n${rows.join("\n") || "(empty)"}`;
}

// Skill-only regions of the shared workflow prompts are fenced so they can be dropped wholesale when the
// skill layer is off. Leaving them in would instruct the agent to call tools that are not registered, and
// the dead text is the overhead that disabling the layer exists to remove.
const SKILL_REGION = /[ \t]*<!--\s*cairn:skills\s*-->[\s\S]*?<!--\s*\/cairn:skills\s*-->\n?/g;
const SKILL_MARKER = /[ \t]*<!--\s*\/?cairn:skills\s*-->\n?/g;
export function applySkillSections(text: string, enabled: boolean): string {
  return (enabled ? text.replace(SKILL_MARKER, "") : text.replace(SKILL_REGION, ""))
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function selectedSkillBlock(ids: string[]): string {
  const selected = ids.map((id) => visibleSkill(id)).filter(Boolean);
  if (selected.length !== ids.length) return "[cairn] Skill selection failed: unknown or unlearned skill id.";
  return selected.map((skill) =>
    `## Selected skill: ${skill!.task} (${skill!.id})\n${skill!.masterPrompt}`
  ).join("\n\n");
}

export function skillIdsFromTask(input: Record<string, unknown>): string[] {
  if (Array.isArray(input.skillIds)) return input.skillIds.filter((id): id is string => typeof id === "string");
  const prompt = typeof input.prompt === "string" ? input.prompt : "";
  const line = prompt.match(/(?:^|\n)CAIRN_SKILL_IDS:\s*([0-9a-f,\s-]+)/i)?.[1];
  return line ? line.split(",").map((id) => id.trim()).filter(Boolean) : [];
}
