import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { writeFileSync } from "node:fs";
import { z } from "zod";
import { config } from "../core/config";
import { neighborContext } from "./context";
import type { Neuron } from "../core/neurons.types";
import type { ScoredResult } from "../core/search.types";

// The bridge that lets an agent read and write the brain. THREE tools, each a thin wrapper
// over src/core (the same code the tests cover). Run: bun src/mcp/server.ts
//
// Tool handlers resolve their logic through dynamic imports. Hosts that deliberately run this file with
// Bun hot reload can refresh handler behavior, while Copilot uses a stable stdio process because it starts
// the command without a Cairn project cwd. Tool names and schemas are session-scoped in either mode.

const server = new McpServer({ name: "cairn", version: "1.0.0" });
const json = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data) }] });
const fail = (msg: string) => ({ content: [{ type: "text" as const, text: msg }], isError: true });

// Attach a viewer deep-link so callers can show/cite the thought in the UI. Used on the single-node
// create/mutate returns, where the agent needs the url to report or link the node.
const withUrl = <T extends Neuron>(n: T) => ({ ...n, url: `${config.uiUrl}/node/${n.id}` });

// Lean agent-facing search hit. Keep the handle (`id`), the knowledge (`text`/`answer`/`citation`) and
// the relevance (`score`); DROP `edges` and `url`. `edges` is server-only graph data the agent cannot
// act on (no get-by-id tool), and the things that DO use it (the UI graph, optional subtree expansion)
// read it from core search()/the DB, not from this payload; `url` is derivable from `id`. Search returns
// many nodes, so trimming these two cuts a real slice off dense, hub-heavy result sets. The graph stays
// fully intact in the brain; it just no longer rides along in every result.
const leanHit = ({ id, text, answer, citation, score }: ScoredResult) => ({ id, text, answer, citation, score });

// Optional hard cap on the agent-facing result set, OFF by default (0): the breadth is controlled by
// the adaptive relevance floor in core search() (CAIRN_RELATIVE_FLOOR), a relevance bar rather than a
// count cap. Set CAIRN_SEARCH_LIMIT > 0 to also impose a top-N count cap as a backstop.
const SEARCH_LIMIT = Number(process.env.CAIRN_SEARCH_LIMIT || "0");

server.tool(
  "brain_search",
  "Returns the most relevant thoughts, ranked most-relevant-first (top matches only — refine the query for a different slice). Each result has a `score` (0-1 cosine relevance): weight high-scoring thoughts heavily and treat low-scoring ones as weak, tangential context. A result may also carry `prior`/`next`: the adjacent question above/below it in the brain's reasoning graph, for context. Use this as much as possible to learn from previous thoughts",
  { query: z.string().describe("What you are looking for, in natural language.") },
  async ({ query }) => {
    const { search } = await import("../core/search");
    const { refsByIds } = await import("../core/neurons");
    // Relevance-ranked search (cosine, most-relevant-first).
    const hits = await search(query);
    const capped = SEARCH_LIMIT > 0 ? hits.slice(0, SEARCH_LIMIT) : hits;
    // Resolve each hit's adjacent decomposition questions (prior = parent, next = child) to short text:
    // a compact, useful use of edges (where a recalled thought sits in the reasoning flow) instead of
    // raw neighbor UUIDs the agent can't act on. One batched lookup for every referenced neighbor.
    const refs = refsByIds(capped.flatMap((h) => [h.id, ...h.edges]));
    const thoughts = capped.map((h) => ({ ...leanHit(h), ...neighborContext(h, refs) }));
    // The result set is kept tight by the adaptive relevance floor (CAIRN_RELATIVE_FLOOR, default 0.85 of the
    // top score) rather than a character cap — only genuinely-relevant thoughts qualify, so the payload stays
    // small without ever truncating a node's answer. Tighten the floor (or set CAIRN_SEARCH_LIMIT) to trim more.
    // Piggyback: when the skill layer is enabled (skillsEnabled, off by default), surface the matching skill's
    // curated steps as a SEPARATE blob (top-2); skillBlob returns [] when it is off.
    // Threshold-gated so an unrelated search returns none. Shape is unchanged (the bare array) unless a skill
    // actually matches, so default consumers are untouched.
    const { skillBlob } = await import("../skill/hook");
    const skills = await skillBlob(query);
    return json(skills.length ? { thoughts, skills } : thoughts);
  }
);

server.tool(
  "brain_create",
  "Create a thought and return its id. Phrase it as an open question (what / how / why / which) — a yes/no question presumes its answer and cannot be split. Keep it concise, bloated text pollutes search. Link related thoughts by id so future agents can build on them",
  {
    text: z.string().describe("An open question starting with what / how / why / which. Never a yes/no question."),
    edges: z.array(z.string()).optional().describe("ids of related thoughts to link to."),
  },
  async ({ text, edges }) => {
    if (!text.trim()) return fail("text is required");
    const { create } = await import("../core/neurons");
    return json(withUrl(await create(text, edges ?? [])));
  }
);

server.tool(
  "brain_mutate",
  "Update an existing thought by id. Provide only the fields to change. Setting `answer` marks it solved. Returns the updated thought",
  {
    id: z.string().describe("id of the thought to update."),
    text: z.string().optional().describe("new question text."),
    answer: z.string().optional().describe("the solution; setting this marks it solved. Keep it concise and clear; an overlong answer is rejected, so split a sprawling one into child nodes instead."),
    citation: z
      .string()
      .optional()
      .describe("REQUIRED whenever you set a non-empty answer: the real source URL(s) you actually consulted. A thought with an answer but no citation is rejected"),
    edges: z.array(z.string()).optional().describe("the complete set of linked thought ids."),
  },
  async ({ id, text, answer, citation, edges }) => {
    try {
      const { mutate } = await import("../core/neurons");
      const n = await mutate(id, { text, answer, citation, edges });
      return n ? json(withUrl(n)) : fail(`no thought with id ${id}`);
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  }
);

server.tool(
  "brain_delete",
  "Delete a thought by id (removes it and detaches its edges from other thoughts). Use to clear duplicates or mistakes.",
  { id: z.string().describe("id of the thought to delete.") },
  async ({ id }) => {
    const { remove } = await import("../core/neurons");
    return json({ deleted: remove(id) });
  }
);

// Agent-facing skill retrieval. Before doing a task, the agent calls this with a description of it and gets
// back curated step-by-step "masters" distilled from past runs of that task, plus the catalog of all skills.
// The agent picks the matching one and follows its steps. Returning several candidates (not force-injecting
// one) is deliberate: it lets the agent disambiguate near-duplicate skills (writing vs reviewing a story) with
// full context, which a cosine auto-injection cannot. Returns empty arrays when the skill layer is off/empty.
server.tool(
  "skill_search",
  "Search your learned skills BEFORE a task, with a short description of it. Returns matching skills (each an `id` + curated steps) and the full catalog (each an `id`). If one fits, follow its steps and keep its `id` for skill_review. This reuses hard-won process.",
  { task: z.string().describe("A short description of the task you are about to do (e.g. 'write a short story', 'review a PR', 'debug a flaky test').") },
  async ({ task }) => {
    const { skillSearch } = await import("../skill/hook");
    return json(await skillSearch(task));
  }
);

// Agent-facing skill creation. When skill_search turns up nothing that fits (or nothing SPECIFIC enough), the
// agent mints a new skill with this tool and gets back its `id`, does the work, then iterates it with
// skill_review(id). Creating up front makes the new skill discoverable to other sessions immediately.
server.tool(
  "skill_create",
  "Create a NEW skill when skill_search found nothing fitting. Label it 1-4 lowercase words by what it produces (e.g. 'short story', 'pr review'). Returns its `id`: do the work, deliver the result, then call skill_review with that `id` (last).",
  { label: z.string().describe("A short label (1-4 lowercase words) naming the task by what it produces.") },
  async ({ label }) => {
    if (!label.trim()) return fail("label is required");
    const { skillCreate } = await import("../skill/hook");
    return json(await skillCreate(label));
  }
);

// Agent-facing DIRECT refinement. Lets the agent fix a skill's master the moment it learns a better way —
// classically, the user says "that was wrong, do X next time" — so the correction lands in the master
// immediately and the very next run uses it, instead of waiting for the background grader to catch up.
server.tool(
  "skill_edit",
  "Refine a skill's master prompt directly when you've learned to do it better — e.g. the user corrected you. Pass the skill `id` (from skill_search) and the rewritten master (numbered imperative steps only). Folds the fix in immediately so the next run uses it, without waiting for the background grader.",
  {
    id: z.string().describe("The id of the skill to refine (from skill_search or skill_create)."),
    master: z.string().describe("The rewritten master: numbered imperative steps only, no rationale/preamble."),
    explanation: z.string().optional().describe("Optional rationale for the next reviewer (why this is better); never shown to the doer."),
  },
  async ({ id, master, explanation }) => {
    const { skillEdit } = await import("../skill/hook");
    const r = await skillEdit(id, master, explanation);
    return r.ok ? json(r) : fail(r.error || "skill_edit failed");
  }
);

// The LEARNER's submission tool. It is registered ONLY in the learner context (when CAIRN_SKILL_OUTPUT_PATH
// is set — the background `copilot -p`/`claude -p` learner bakes that env into its own cairn server). The
// MAIN agent's cairn server has no such env, so skill_output is NEVER exposed to it — the agent uses
// skill_search / skill_create / skill_review, and can no longer mistakenly call this internal tool.
if (process.env.CAIRN_SKILL_OUTPUT_PATH) {
  server.tool(
    "skill_output",
    "The learner submits its finished review here, ONCE, as the last action after reasoning out loud: the 0..1 quality score, what worked / what failed / one concrete improvement, and the rewritten master prompt a future agent will load. The task's label is already decided and supplied by the loop, so do NOT pass it.",
    {
      score: z.number().describe("Quality of the graded output, 0..1."),
      right: z.string().describe("What the output did well."),
      wrong: z.string().describe("What the output got wrong or missed."),
      improve: z.string().describe("One concrete change for next time."),
      master: z.string().describe("The rewritten master prompt: the numbered steps ONLY (no rationale paragraph). This is the only text injected into the doer."),
      explanation: z.string().describe("The 2-to-4-sentence rationale for the next reviewer (why the best runs win, what excellent looks like, the failure mode to avoid). Never shown to the doer."),
    },
    async ({ score, right, wrong, improve, master, explanation }) => {
      // The label is the loop's, not the learner's: it was decided before this call and passed in via
      // CAIRN_SKILL_FORCED_LABEL. An empty forced label means a non-task (no skill, empty master ok).
      const lbl = (process.env.CAIRN_SKILL_FORCED_LABEL ?? "").trim();
      // Validate hard, then ERROR back so the learner resends correctly, never accept a half-formed review.
      const problems: string[] = [];
      if (lbl) {
        if (!Number.isFinite(score) || score < 0 || score > 1) problems.push("score must be a number in [0,1]");
        if (!master.trim()) problems.push("master must be a non-empty rewritten prompt (numbered steps) for a labeled task");
        if (!explanation.trim()) problems.push("explanation must be a non-empty rationale for a labeled task");
        if (!right.trim() && !wrong.trim() && !improve.trim()) problems.push("provide at least one of right/wrong/improve");
      } else if (master.trim() || explanation.trim()) {
        problems.push("master and explanation must be empty when label is empty (a non-task forms no skill)");
      }
      if (problems.length) return fail(`skill_output rejected, call it again with every field correct: ${problems.join("; ")}`);
      const p = process.env.CAIRN_SKILL_OUTPUT_PATH;
      if (p) { try { writeFileSync(p, JSON.stringify({ label: lbl, score, right, wrong, improve, master, explanation })); } catch { /* capture is best-effort */ } }
      return json({ ok: true });
    }
  );
}

// The SEGMENTER's submission tool has been removed: the agent now declares the skill directly (skill_search /
// skill_create + skill_review), so the reviewer never classifies a turn and no segmentation is needed.

// The AGENT's "this deliverable is finished, review it as skill <id>" signal. The agent knows what it just
// did — it reused a skill it found with skill_search, or minted one with skill_create — so it declares that
// skill's ID here and the reviewer's only job is to grade this deliverable against that skill and iterate its
// master. Referencing the concrete id (not a re-typed label) means the run can never drift onto a near-
// duplicate. TIMING MATTERS: the postToolUse hook fires the learner immediately over the transcript UP TO this
// call, so the agent must DELIVER its finished result first and call skill_review last (and, if it delegated,
// only after the subagent has returned) — otherwise the grader sees an unfinished turn with no deliverable.
// The tool validates the id and acknowledges; the host's postToolUse hook reads the id and reviews the whole
// turn log, so this is a no-op when skills are off or run outside a hooked host.
server.tool(
  "skill_review",
  "Call LAST, after delivering the finished result — it grades the turn up to this call, so reviewing before you deliver grades nothing. Pass the skill `id` (from skill_search or skill_create). If you delegated, call only after the subagent returned. Once per deliverable; never for chit-chat or a status update.",
  {
    id: z.string().describe("The id of the skill this deliverable belongs to, as returned by skill_search or skill_create."),
  },
  async ({ id }) => {
    if (!id.trim()) return fail("id is required (pass the skill id from skill_search or skill_create)");
    const { getSkill } = await import("../skill/store");
    if (!getSkill(id.trim())) return fail("unknown skill id; pass an id returned by skill_search or skill_create");
    // The transcript path lives with the host hook, not here, so this tool cannot fire the learner itself; it
    // just acknowledges. The postToolUse hook sees this call, reads the id, and reviews the turn log.
    return json({ ok: true });
  }
);

// Bind the stdio transport exactly once. This guard also keeps optional hot-reload hosts from binding a
// second listener to the same stdin.
const hotState = globalThis as typeof globalThis & { __cairnConnected?: boolean };
if (!hotState.__cairnConnected) {
  hotState.__cairnConnected = true;
  await server.connect(new StdioServerTransport());
}
