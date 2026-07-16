import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Database } from "bun:sqlite";
import { db } from "../src/core/db";
import { config } from "../src/core/config";
import { embed, embedModel } from "../src/core/embed";
import { encodeVector } from "../src/core/vector";
import { normalizeLabel, skillCatalog } from "../src/skill/store";

interface Target {
  id: string;
  title: string;
  description: string;
  master: string;
  merge: string[];
}

const targets: Target[] = [
  {
    id: "2f2dc14c-213a-426c-88dc-6ca1bc164a3f", title: "office bohemia coding",
    description: "Use for implementing or fixing Office-Bohemia and New Office product code, correcting routes or data flow, and matching pulled Office references with repository-native architecture and controls.",
    master: "1. Search the brain and repository guidance for the affected product surface.\n2. Convert the request into observable acceptance criteria.\n3. Identify the exact route, package, component, data boundary, and native primitives involved.\n4. Preserve unrelated work and inspect the active diff before editing.\n5. Reproduce the current behavior with the smallest direct probe.\n6. Implement the root fix using repository tokens, controls, types, and architecture.\n7. Add or update the narrowest regression covering the behavior.\n8. Run targeted build, type, lint, test, and browser checks for the changed surface.\n9. Compare the final behavior against every acceptance criterion and report exact paths and measurements.",
    merge: ["d3fea3e7-fc58-4f68-b675-86ce37bd3368","1ad60c7a-a134-4358-b476-b98869015868","c4e56a11-9920-4384-bf33-2262cf3c95dd","2801d76a-d917-4302-a6f4-f7ded5817c33","9d576edb-b4aa-4a3b-b21c-edf7c4ba98be","4eb29bd3-80af-4144-971f-aa5106123c09","3df8ddf8-ef4a-4347-92ab-750286dd6c24","b2cbade0-01fa-4b72-be83-9376e388b9a3"],
  },
  {
    id: "f1ca99bf-b184-4eea-a6db-24ca655e1343", title: "visual fidelity testing",
    description: "Use for matching a page to a visual reference, auditing UI across viewports, or proving focus, keyboard, accessibility, responsive, and interaction behavior with browser evidence.",
    master: "1. Identify the exact reference, target, route, state, viewport, and revision.\n2. Capture both surfaces at identical browser metrics.\n3. Build a ledger for content, geometry, paint, assets, interaction, focus, accessibility, and responsive behavior.\n4. Measure the highest-impact deltas with DOM, computed-style, screenshot, and event probes.\n5. Trace each delta to the earliest owning component, token, or state transition.\n6. Implement the smallest coherent fix without altering unrelated behavior.\n7. Repeat the identical probes and compare before-versus-after measurements.\n8. Run the narrow browser regression plus relevant build, type, lint, and unit gates.\n9. Report remaining deltas, artifact paths, counts, and exact acceptance status.",
    merge: ["51b06d17-4cbb-4408-8a0f-6ee034f8493b","94a382cb-1925-43e4-83ec-bdb42ae1e5f0","149cf4ec-305c-4b85-aae9-e07d30e64279","fa726823-e297-458d-abce-018d827441b8","42df467b-5c98-4983-a36d-88ade3bb06db","7414d1e5-3b1c-47e5-aef5-121012f580db","8c6380f5-feeb-4b78-8bb4-9ba42b05ff5b","2643fbc5-962b-4c51-adbd-54bd6b5bcfa4","9412d34b-6cbc-4bd3-a087-4f5791da9c6e","04e2da92-74cc-4913-8ca5-d3bb18447f75","bca68ef5-6513-42a5-abe3-5896c8d9a7b6"],
  },
  {
    id: "fb3011f9-5a87-4346-93de-5a60bf0afe90", title: "site spec extraction",
    description: "Use for capturing a web page into a reusable React specification, fixing extractor fidelity, or validating generated content, styling, assets, and behavior from clean evidence.",
    master: "1. Search the brain for extractor architecture, provenance failures, and prior fidelity defects.\n2. Lock the source URL, authenticated state, viewport, route, and output contract.\n3. Capture structured DOM, computed style, assets, responsive rules, and interactions from the source.\n4. Preserve provenance from each emitted component and token to its captured evidence.\n5. Generate clean reusable React source rather than exposing internal evidence JSON.\n6. Validate one representative component and story before expanding scope.\n7. Compare generated output to the source at identical metrics and fix the extractor's earliest divergence.\n8. Run targeted extractor, reconstruction, build, and browser regressions.\n9. Report source identity, generated paths, measured fidelity, and remaining unsupported behavior.",
    merge: ["cb0119b9-a091-433b-936b-34ce33a16e97"],
  },
  {
    id: "21c1661b-8bb6-4ae5-8591-4d166b58a6fb", title: "skill system audit",
    description: "Use for debugging missing Cairn calls, fixing skill review grading, or changing injection, catalog routing, persistence, retries, and subagent lifecycle behavior.",
    master: "1. Search the brain for intended lifecycle invariants and prior failures.\n2. Define the exact human-message, model-turn, tool, stop, review, and persistence boundaries.\n3. Capture a chronological failing trace from real host events and durable rows.\n4. Distinguish hook invocation, agent compliance, queue acceptance, worker completion, and learned output.\n5. Convert the trace into deterministic first-turn, queued, reminder, retry, restart, and subagent fixtures.\n6. Fix the earliest proven divergence with explicit errors and bounded retries.\n7. Upgrade installed host configuration idempotently and preserve version compatibility.\n8. Run live-host probes, targeted regressions, type checks, blind review, and the complete suite.\n9. Record before-versus-after sequences, counts, persistent changes, and remaining limitations.",
    merge: [],
  },
  {
    id: "206fe8ad-f7a5-4f79-89da-b6ddef88e44c", title: "agent coordination",
    description: "Use for running persistent multi-agent implementations, reconciling parallel evidence, or safely cancelling and reassigning work through explicit ownership, durable tasks, and completion gates.",
    master: "1. Define the complete team, scope, ownership, and durable deliverables.\n2. Search the brain for coordination failures, authority rules, and proven handoff patterns.\n3. Create one canonical task graph with explicit dependencies and completion criteria.\n4. Give each agent disjoint context, one owned task, and an exact return contract.\n5. Keep each agent in one persistent session and incorporate every returned result before advancing.\n6. Reconcile chronology, authority, artifact identity, and measurements into one current-state ledger.\n7. Route each unresolved item once to an eligible owner and prevent duplicate assignments.\n8. Gate completion on committed state, terminal owner evidence, and required validations.\n9. Persist task state, messages, artifacts, failures, and the next action for restart recovery.",
    merge: ["8932df65-219f-4be7-b4a5-4d1044cb18e4","719d053f-05e2-4c96-bd5d-1a58f7ac098f","26fd980e-5aa9-4e16-aa6d-71e5ae4ce48f","2359f3c0-f6f9-4407-b5fb-2fd79e901f45","673b089c-18f3-43ef-b5c1-1bf3a25f0c2e","7dc07d2d-503c-4557-b829-b1a8fb83ce9c","8f208bdd-c2ca-468d-8005-7a8a099aabba","20691926-76f5-4fe8-842c-7a6cdedbfded","2d1926c5-4ff3-4198-8b19-2a74ad7ab083","a927eb85-14b3-444a-ad81-a455d5909b01","861707cf-f21f-4993-90a7-f19a086f2ae6","9a1d9bbd-49ca-4944-96c1-d8734bb1aea6","db115e6a-0b0a-4715-95e3-fbbcff8009a3"],
  },
  {
    id: "266f1943-35c8-4a64-8f7f-d1b37b6ac163", title: "cli troubleshooting",
    description: "Use for debugging CLI errors, repairing broken sessions, or diagnosing local servers, configuration, paths, permissions, dependencies, and environment failures from exact evidence.",
    master: "1. Capture the exact command, error, version, environment, working directory, and expected outcome.\n2. Search the brain and current official documentation for the precise symptom.\n3. Inspect configuration, process state, logs, paths, permissions, and dependencies without changing them.\n4. Form one causal hypothesis and test it with the smallest direct probe.\n5. Apply the narrowest reversible fix at the earliest failing boundary.\n6. Rerun the original command and inspect the real output.\n7. Check adjacent session, persistence, and restart behavior.\n8. Report the root cause, commands, changed state, and any remaining limitation.",
    merge: ["54efcd7f-efad-4c60-b883-628842f4e1a0","12c079a9-97a8-42a5-986f-672b463fffd3"],
  },
  {
    id: "81dc076a-4154-4554-bfc5-a9182c3205a9", title: "code review",
    description: "Use for reviewing pull request diffs, auditing uncommitted changes, or rechecking revisions for high-confidence correctness, security, concurrency, and logic defects.",
    master: "1. Read the complete change set and repository instructions.\n2. Identify the intended behavior and affected invariants from surrounding code and tests.\n3. Trace changed data, state, error, concurrency, security, and lifecycle paths end to end.\n4. Reproduce or prove each suspected defect before reporting it.\n5. Ignore style and low-confidence speculation.\n6. Report only actionable findings with severity, file, line, failing scenario, and impact.\n7. State explicitly when no high-confidence findings remain.",
    merge: [],
  },
  {
    id: "d79d772e-141e-419d-bab8-5c267544ac8b", title: "pr review comment",
    description: "Use when a verified pull-request defect needs one concise natural review comment explaining the concrete issue, practical impact, and requested change.",
    master: "1. Read the exact diff and surrounding code for the issue.\n2. Verify the defect and its practical consequence.\n3. Point to the relevant behavior without restating the whole implementation.\n4. Write one or two plain-English sentences in the user's terse voice.\n5. Avoid headings, filler, praise, speculation, and em dashes.",
    merge: [],
  },
  {
    id: "d44c4885-ae7e-4c17-a439-d2a169a5a1f7", title: "test execution",
    description: "Use for running repository test suites, validating focused changes, or diagnosing failing type, lint, build, and test commands without adding new tooling.",
    master: "1. Read the repository's existing validation commands and scope rules.\n2. Select the smallest command that covers the changed behavior.\n3. Run related selectors together with pagers and noisy output disabled.\n4. Preserve the full failure output and reduce successful output to counts and timing.\n5. Diagnose missing dependencies only after the existing command fails for that reason.\n6. Escalate to broader validation only when targeted results require it.\n7. Report command, exit status, counts, timing, and exact failure location.",
    merge: [],
  },
  {
    id: "3af1f7d5-a7fc-41e4-9b3e-713ef3161dfb", title: "poetry writing",
    description: "Use for writing a haiku or short poem, or revising poetry for a clearer emotional thesis, concrete sourced imagery, deliberate form, sound, compression, and fresh language.",
    master: "1. Search the brain for prior poems, repeated imagery, forms, and emotional territory.\n2. Form one emotional thesis from concrete outside material relevant to the prompt.\n3. Choose a form whose constraints intensify that thesis.\n4. Generate several image and turn candidates grounded in sensory detail.\n5. Select the least predictable causal and emotional movement.\n6. Draft with precise sound, lineation, compression, and a purposeful turn.\n7. Remove generic abstraction, explanation, and familiar poetic shorthand.\n8. Verify the form mechanically and compare every line against the thesis.\n9. Deliver only the finished poem unless analysis was requested.",
    merge: ["21cededb-24f4-40af-86d3-b1facbb75ae1"],
  },
  {
    id: "a5506f4d-cfec-4945-9dfb-fde94e20eeb5", title: "creative concept development",
    description: "Use for developing book premises, campaign or menu directions, and visual or cover concepts from sourced context, a clear thesis, causal stakes, and comparative originality.",
    master: "1. Fetch current authoritative context relevant to the brief.\n2. Form one nonobvious thesis connecting the evidence to a human consequence or emotion.\n3. Search the brain for prior concepts and repeated mechanisms.\n4. Generate three candidates with distinct causal engines, stakes, and irreversible choices.\n5. Compare each candidate for originality, fit, emotional cost, and executable detail.\n6. Replace any mechanism duplicated in prior work or competing candidates.\n7. Select the strongest concept and specify premise, audience, conflict, turn, ending or payoff, tone, and visual language.\n8. Test how each major choice expresses the thesis rather than decorating it.\n9. Deliver a concise decision-ready concept with sources and tradeoffs.",
    merge: ["b06d839c-9ac1-451d-8fd9-4f61e8d78712","15b0a439-c2c3-4dfd-afa1-1348f93701b8","f2a1ff2d-cd30-4a3d-9930-2bf75c23ce9e","0ab4b41f-8cfe-4b7c-a200-bc8846a951f5"],
  },
  {
    id: "6a0059d7-0469-4882-b596-8055a245b198", title: "songwriting",
    description: "Use for planning song concepts, writing metered lyrics, or reviewing and revising compositions through emotional context, structure, melody, production intent, and performance.",
    master: "1. Search the brain for the active project, prior songs, repeated devices, and unresolved themes.\n2. Fetch concrete context and form one emotional thesis for the song.\n3. Define narrator, scene, conflict, irreversible turn, and listener payoff.\n4. Choose structure, meter, rhyme, melodic contour, and production movement that serve the thesis.\n5. Generate multiple hook, verse, and bridge mechanisms before selecting one.\n6. Draft lyrics with singable stress, concrete images, causal progression, and fresh phrasing.\n7. Map arrangement and dynamics to each structural turn without stock defaults.\n8. Test meter, repetition, perspective, emotional escalation, and originality aloud.\n9. Revise the weakest section and report the final structure and production intent.",
    merge: ["d2b0b86e-9bb1-40b6-a755-16aa6ca8c6e2","68c6106e-8906-4a5b-b27d-c1cae6dea76c","0e29f272-c787-4ac9-abd7-76d5886507b7","837f80e8-c2ec-474e-ae22-763268de55e7","adfe22fc-e9c7-4860-a746-c2d40d073b29"],
  },
];

const deleteIds = new Set(["498050cb-af67-459d-b35b-cf1c43de0e8d","873017e3-fd5e-4ed3-9e77-b3c11f980034"]);
const apply = process.argv.includes("--apply");
const database = db();
skillCatalog();
const known = new Set([...targets.flatMap((target) => [target.id, ...target.merge]), ...deleteIds]);
const readLearned = () => database.query("SELECT id, task FROM skills WHERE TRIM(master_prompt) <> '' AND TRIM(description) <> ''").all() as { id: string; task: string }[];
const learned = readLearned();
const unknown = learned.filter((skill) => !known.has(skill.id));
if (unknown.length) throw new Error(`Unmapped learned skills: ${unknown.map((skill) => skill.task).join(", ")}`);
console.log(JSON.stringify({ apply, before: learned.length, after: targets.length, unknown }, null, 2));
if (!apply) process.exit(0);

const backup = join(dirname(config.dbPath), `cairn.db.before-skill-catalog-${Date.now()}.bak`);
database.run("BEGIN IMMEDIATE");
try {
  const lockedUnknown = readLearned().filter((skill) => !known.has(skill.id));
  if (lockedUnknown.length) throw new Error(`Skills changed before migration: ${lockedUnknown.map((skill) => skill.task).join(", ")}`);
  const snapshot = new Database(config.dbPath, { readonly: true });
  try { writeFileSync(backup, snapshot.serialize()); } finally { snapshot.close(); }
  for (const target of targets) {
    for (const source of target.merge) {
      database.run("UPDATE skill_runs SET skill_id = ? WHERE skill_id = ?", target.id, source);
      database.run("UPDATE skill_versions SET skill_id = ? WHERE skill_id = ?", target.id, source);
      database.run("DELETE FROM skills WHERE id = ?", source);
    }
  }
  for (const id of deleteIds) {
    database.run("DELETE FROM skill_runs WHERE skill_id = ?", id);
    database.run("DELETE FROM skill_versions WHERE skill_id = ?", id);
    database.run("DELETE FROM skills WHERE id = ?", id);
  }
  const uncurated = database.query("SELECT id FROM skills WHERE TRIM(master_prompt) = '' OR TRIM(description) = ''").all() as { id: string }[];
  for (const skill of uncurated) {
    database.run("DELETE FROM skill_runs WHERE skill_id = ?", skill.id);
    database.run("DELETE FROM skill_versions WHERE skill_id = ?", skill.id);
    database.run("DELETE FROM skills WHERE id = ?", skill.id);
  }
  const curatedAt = Date.now();
  for (const target of targets) {
    const latest = database.query("SELECT master FROM skill_versions WHERE skill_id = ? ORDER BY ts DESC, id DESC LIMIT 1").get(target.id) as { master?: string } | undefined;
    database.run(
      "UPDATE skills SET task = ?, label_norm = ?, description = ?, master_prompt = ?, explanation = ? WHERE id = ?",
      target.title, normalizeLabel(target.title), target.description, target.master,
      `Curated broad capability replacing narrow topic and coordination variants. Use it only for the listed reusable methods and examples.`,
      target.id,
    );
    if (latest?.master !== target.master) {
      database.run(
        "INSERT INTO skill_versions (skill_id, master, explanation, score, ts) VALUES (?, ?, ?, 0, ?)",
        target.id,
        target.master,
        "Curated catalog migration consolidated narrow skills into this reusable capability.",
        curatedAt,
      );
    }
  }
  const skillColumns = database.query("PRAGMA table_info(skills)").all() as { name: string }[];
  if (skillColumns.some((column) => column.name === "use_cases")) database.run("ALTER TABLE skills DROP COLUMN use_cases");
  database.run("COMMIT");
} catch (error) {
  database.run("ROLLBACK");
  throw error;
}
for (const target of targets) {
  const labelVector = await embed(target.title);
  const richVector = await embed(`${target.title}. ${target.description}. ${target.master}`);
  database.run("UPDATE skills SET embedding = ?, rich = ?, embedding_model = ? WHERE id = ?", encodeVector(labelVector), encodeVector(richVector), embedModel(), target.id);
}
console.log(JSON.stringify({ backup, learned: database.query("SELECT COUNT(*) count FROM skills WHERE TRIM(master_prompt) <> ''").get() }, null, 2));
