import { createHash } from "node:crypto";
import { skillCatalogDetails, visibleSkill, type SkillCatalogEntry } from "./store";

export interface SkillCatalogSnapshot {
  version: string;
  catalog: (SkillCatalogEntry & { alias: string })[];
}

const aliasForIndex = (index: number): string => `s${(index + 1).toString(36)}`;

export function skillCatalogSnapshot(): SkillCatalogSnapshot {
  const details = skillCatalogDetails();
  const version = createHash("sha256").update(JSON.stringify(details)).digest("hex");
  return {
    version,
    catalog: details.map(({ masterPrompt: _masterPrompt, ...entry }, index) => ({
      ...entry,
      alias: aliasForIndex(index),
    })),
  };
}

export function skillAliasMap(snapshot = skillCatalogSnapshot()): Map<string, string> {
  return new Map(snapshot.catalog.map((skill) => [skill.alias, skill.id]));
}

export function formatSkillCatalog(mode: "full" | "titles" = "titles"): string {
  const snapshot = skillCatalogSnapshot();
  const rows = snapshot.catalog.map((skill) => mode === "titles"
    ? `${skill.alias} ${skill.title}`
    : `- \`${skill.alias}\` **${skill.title}**: ${skill.description}`);
  return `## Available skill catalog\nCatalog version: \`${snapshot.version}\`\nPass this exact version as \`catalogVersion\` to \`skill_select\`.\n${rows.join("\n") || "(empty)"}`;
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
