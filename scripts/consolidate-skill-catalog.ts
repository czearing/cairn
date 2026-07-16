import { Database } from "bun:sqlite";
import { dirname, join } from "node:path";
import { config } from "../src/core/config";
import { db } from "../src/core/db";
import { embed, embedModel } from "../src/core/embed";
import { encodeVector } from "../src/core/vector";
import { normalizeLabel } from "../src/skill/store";

const SOFTWARE_ID = "0ed731db-3fcf-4c5b-9f14-947a1f5dd1a6";
const CODE_REVIEW_ID = "81dc076a-4154-4554-bfc5-a9182c3205a9";
const INTERFACE_ID = "f1ca99bf-b184-4eea-a6db-24ca655e1343";
const OFFICE_ID = "2f2dc14c-213a-426c-88dc-6ca1bc164a3f";

const software = {
  id: SOFTWARE_ID,
  task: "software implementation",
  description: "Use for implementing or refactoring production code from a defined requirement, tracing architecture and data flow, preserving behavior, adding focused tests, and validating the complete change.",
  master: "1. Read repository instructions, the request, relevant architecture, and existing tests.\n2. Convert the request into observable behavior and protected invariants.\n3. Inspect the active diff, ownership boundaries, and reusable local patterns.\n4. Reproduce the current behavior with the smallest direct probe.\n5. Trace the earliest incorrect state, data, or control-flow boundary.\n6. Implement the root fix with repository-native types, helpers, and architecture.\n7. Add the narrowest regression proving the changed behavior.\n8. Run targeted validation, then broader existing checks only when required.\n9. Audit the final diff against every acceptance criterion and report exact evidence.",
};
const office = {
  id: OFFICE_ID,
  task: "office bohemia coding",
  description: "Use alongside software implementation when changing Office-Bohemia or New Office code, so the implementation follows Office package boundaries, pulled references, controls, tokens, localization, and product-specific data flow.",
  master: "1. Search the brain and repository guidance for the affected Office product surface.\n2. Identify the exact route, package, component, data boundary, and pulled Office reference.\n3. Map the requested behavior onto existing Office controls, tokens, types, and package ownership.\n4. Preserve localization, accessibility, telemetry, and shared contracts used by adjacent Office surfaces.\n5. Implement through repository-native Office primitives rather than clone-specific or page-local substitutes.\n6. Compare the result with the pulled reference and the current Office behavior at identical states.\n7. Run the Office-specific build, localization, browser, and package checks required by the changed surface.",
};
const codeReview = {
  id: CODE_REVIEW_ID,
  task: "code review",
  description: "Use for reviewing diffs or uncommitted changes, verifying correctness and security defects, and converting a proven finding into a concise pull-request review comment when requested.",
  master: "1. Read the complete change set, repository instructions, task, surrounding code, and relevant tests.\n2. Derive the intended behavior and invariants for every changed surface.\n3. Trace changed data, state, error, concurrency, security, and lifecycle paths end to end.\n4. Reproduce or prove each suspected defect before reporting it.\n5. Ignore style and low-confidence speculation.\n6. Report only actionable findings with severity, file, line, trigger, and impact.\n7. When requested, convert each proven finding into one concise natural review comment.\n8. State explicitly when no high-confidence findings remain.",
};
const interfaceSkill = {
  id: INTERFACE_ID,
  task: "interface design and validation",
  description: "Use for research-led product interface redesigns and for validating content, hierarchy, geometry, responsive behavior, interaction, focus, accessibility, and visual fidelity with browser evidence.",
  master: "1. Identify the exact product surface, user workflow, current state, target state, viewport, and revision.\n2. Inspect the component hierarchy, data model, interactions, responsive behavior, accessibility, and existing tests.\n3. Research current primary product and accessibility sources for the specific interaction pattern.\n4. Form one interface thesis that separates root usability causes from visual symptoms.\n5. Specify hierarchy, geometry, copy, states, interaction, focus, motion, responsiveness, and accessibility behavior.\n6. Map the specification to exact components, data boundaries, stories, and test surfaces.\n7. Capture baseline DOM, computed-style, screenshot, event, keyboard, and accessibility evidence.\n8. Validate the implementation across representative states and viewports using identical probes.\n9. Report measured deltas, artifacts, remaining risks, and exact acceptance status.",
};

const retire = [
  "3af1f7d5-a7fc-41e4-9b3e-713ef3161dfb",
  "6a0059d7-0469-4882-b596-8055a245b198",
  "a5506f4d-cfec-4945-9dfb-fde94e20eeb5",
  "4f57049e-24b4-4c8d-8dcd-13aa1e65ee76",
];
const merge = [
  { source: "d79d772e-141e-419d-bab8-5c267544ac8b", target: CODE_REVIEW_ID },
  { source: "8e907077-8cf4-44bb-af4f-a53d397cf915", target: INTERFACE_ID },
];
const targets = [software, office, codeReview, interfaceSkill];
const database = db();
database.run("CREATE TABLE IF NOT EXISTS skill_redirects (source_id TEXT PRIMARY KEY, target_id TEXT NOT NULL, ts INTEGER NOT NULL)");
const backup = join(dirname(config.dbPath), `cairn.db.before-catalog-consolidation-${Date.now()}.bak`);
const escaped = backup.replaceAll("'", "''");
database.run(`VACUUM INTO '${escaped}'`);
const before = {
  skills: (database.query("SELECT COUNT(*) count FROM skills").get() as { count: number }).count,
  runs: (database.query("SELECT COUNT(*) count FROM skill_runs").get() as { count: number }).count,
  versions: (database.query("SELECT COUNT(*) count FROM skill_versions").get() as { count: number }).count,
};
const vectors = new Map<string, { label: number[]; rich: number[] }>();
for (const target of targets) vectors.set(target.id, {
  label: await embed(target.task),
  rich: await embed(`${target.task}. ${target.description}. ${target.master}`),
});
database.transaction(() => {
  for (const item of merge) {
    database.run(`INSERT INTO skill_redirects(source_id,target_id,ts) VALUES (?,?,?)
      ON CONFLICT(source_id) DO UPDATE SET target_id=excluded.target_id,ts=excluded.ts`,
    item.source, item.target, Date.now());
    database.run("UPDATE skill_runs SET skill_id=? WHERE skill_id=?", item.target, item.source);
    database.run("UPDATE skill_versions SET skill_id=? WHERE skill_id=?", item.target, item.source);
    database.run("UPDATE skills SET description='', explanation=? WHERE id=?", `Merged into ${item.target}.`, item.source);
  }
  for (const id of retire) database.run(
    "UPDATE skills SET description='', explanation='Retired from the active catalog; history preserved.' WHERE id=?",
    id,
  );
  for (const target of targets) {
    const vector = vectors.get(target.id)!;
    database.run(`INSERT INTO skills(
      id,task,label_norm,master_prompt,description,explanation,embedding,rich,embedding_model,ts
    ) VALUES (?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET
      task=excluded.task,label_norm=excluded.label_norm,master_prompt=excluded.master_prompt,
      description=excluded.description,explanation=excluded.explanation,
      embedding=excluded.embedding,rich=excluded.rich,embedding_model=excluded.embedding_model`,
    target.id, target.task, normalizeLabel(target.task), target.master, target.description,
    "Curated reusable capability; automatic review candidates remain quarantined.",
    encodeVector(vector.label), encodeVector(vector.rich), embedModel(), Date.now());
    database.run(`INSERT INTO skill_versions(skill_id,master,explanation,score,ts)
      SELECT ?,?,?,0,? WHERE NOT EXISTS(
        SELECT 1 FROM skill_versions WHERE skill_id=? AND master=?
      )`, target.id, target.master, "Catalog consolidation baseline.", Date.now(), target.id, target.master);
  }
});
const after = {
  skills: (database.query("SELECT COUNT(*) count FROM skills").get() as { count: number }).count,
  visible: (database.query("SELECT COUNT(*) count FROM skills WHERE TRIM(description)<>''").get() as { count: number }).count,
  runs: (database.query("SELECT COUNT(*) count FROM skill_runs").get() as { count: number }).count,
  versions: (database.query("SELECT COUNT(*) count FROM skill_versions").get() as { count: number }).count,
};
console.log(JSON.stringify({ backup, before, after }, null, 2));
new Database(config.dbPath, { readonly: true }).close();
