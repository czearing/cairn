import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { writeFileSync } from "node:fs";
import { z } from "zod";
import { create, mutate, remove, refsByIds } from "../core/neurons";
import { search } from "../core/search";
import { config } from "../core/config";
import { neighborContext } from "./context";
import type { Neuron } from "../core/neurons.types";
import type { ScoredResult } from "../core/search.types";

// The bridge that lets an agent read and write the brain. THREE tools, each a thin wrapper
// over src/core (the same code the tests cover). Run: bun src/mcp/server.ts

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
  async ({ id }) => json({ deleted: remove(id) })
);

// Agent-facing skill retrieval. Before doing a task, the agent calls this with a description of it and gets
// back curated step-by-step "masters" distilled from past runs of that task, plus the catalog of all skills.
// The agent picks the matching one and follows its steps. Returning several candidates (not force-injecting
// one) is deliberate: it lets the agent disambiguate near-duplicate skills (writing vs reviewing a story) with
// full context, which a cosine auto-injection cannot. Returns empty arrays when the skill layer is off/empty.
server.tool(
  "skill_search",
  "Search your LEARNED SKILLS before doing a task. Returns curated, step-by-step process masters distilled from past runs of similar tasks, plus the catalog of every skill. Call this FIRST with a short description of the task you are about to do; if a returned skill matches, FOLLOW its steps instead of redoing the work from scratch. This is how you reuse hard-won process.",
  { task: z.string().describe("A short description of the task you are about to do (e.g. 'write a short story', 'review a PR', 'debug a flaky test').") },
  async ({ task }) => {
    const { skillSearch } = await import("../skill/hook");
    return json(await skillSearch(task));
  }
);

// The LEARNER's submission tool. The learner reasons out loud to judge the run (reasoning makes it sharper
// and is never suppressed), then hands its finished review here as structured fields. The skill loop reads
// that JSON (via CAIRN_SKILL_OUTPUT_PATH) instead of parsing the master back out of free text. No-op
// acknowledgement when no path is set.
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
    // The label is the loop's, not the learner's: it was decided before this call by the classifier and
    // passed in via CAIRN_SKILL_FORCED_LABEL. The learner no longer echoes it, so it can
    // neither restate nor corrupt it. An empty forced label means a non-task (no skill, empty master ok).
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

// The SEGMENTER's submission tool (STAGE 1 of the skill loop). The segmenter reads ONE finished turn and
// lists each distinct reusable deliverable it produced — UNANCHORED (it gets no skill master or priors, and
// only this one tool), so it can never be biased into mislabeling a review of X as X. It submits the list
// here as structured rows instead of printing a JSON array we'd have to regex back out of free text; the
// loop reads that JSON via CAIRN_SKILL_SEGMENT_PATH. A non-task submits an empty list. No-op when no path.
server.tool(
  "skill_segment",
  "Submit the list of distinct reusable DELIVERABLES this turn produced, ONCE, as the last action after reasoning out loud. Each row is a {label, what}. Pass an EMPTY list for a turn that produced no reusable deliverable (chit-chat, bookkeeping, a correction). A turn that writes a story AND reviews it submits TWO rows.",
  {
    deliverables: z
      .array(
        z.object({
          label: z.string().describe("The reusable task label in 1-4 lowercase words, by WHAT was produced (a review of a story is 'short story review', never 'short story')."),
          what: z.string().describe("One short phrase naming THIS specific deliverable so a grader can find it in the turn (e.g. 'the story about the lighthouse keeper')."),
        })
      )
      .describe("Every distinct reusable deliverable in the turn. Empty for a non-task."),
  },
  async ({ deliverables }) => {
    // Deterministic normalization only (trim/lowercase/clip/dedup) — never a content judgment: the model
    // decided WHAT the deliverables are; this just canonicalizes the rows and drops exact-label duplicates so
    // one turn never makes two runs of the same skill.
    const out: { label: string; what: string }[] = [];
    const seen = new Set<string>();
    for (const it of deliverables) {
      const label = (it.label ?? "").trim().slice(0, 60).toLowerCase();
      if (!label || seen.has(label)) continue;
      seen.add(label);
      out.push({ label, what: (it.what ?? "").trim().slice(0, 200) });
    }
    const p = process.env.CAIRN_SKILL_SEGMENT_PATH;
    if (p) { try { writeFileSync(p, JSON.stringify({ deliverables: out })); } catch { /* capture is best-effort */ } }
    return json({ ok: true, count: out.length });
  }
);

// The AGENT's explicit "this deliverable is finished, review it now" signal. The skill loop normally fires
// automatically at turn end, but that mis-times work handed to a BACKGROUND subagent: the turn can end on a
// "the reviewer is still running" status line before the real artifact exists, so the loop grades the status
// line (the measured short-story 0.10 runs). This tool lets the agent close that gap: it calls skill_review
// AFTER the finished work (its own or a subagent's) is actually in hand, and the host's postToolUse hook then
// reviews the whole turn log — which by that point contains the subagent's output — instead of guessing at
// turn end. The tool itself only acknowledges; the hook (which alone knows the session's transcript path)
// does the firing, so this is a no-op when skills are off or run outside a hooked host.
server.tool(
  "skill_review",
  "Call this the moment a REUSABLE deliverable is finished and in hand — a written piece, a shipped PR, a fixed bug, a completed analysis. If you delegated the work to a subagent, call it only AFTER that subagent has RETURNED its result, so the finished artifact (not a 'still running' status) is what gets reviewed. Call once per turn when there is a genuine deliverable; do NOT call for chit-chat, a question, a status update, or brain bookkeeping.",
  {
    what: z.string().optional().describe("A short phrase naming what you just finished (e.g. 'the short story about the clockmaker', 'PR #128 for the login button'). For your own intent; the reviewer re-derives the label independently."),
  },
  async ({ what }) => {
    // The transcript path lives with the host hook, not here, so this tool cannot fire the learner itself; it
    // just acknowledges. The postToolUse hook sees this call and reviews the session's full turn log.
    return json({ ok: true, queued: true, what: (what ?? "").trim().slice(0, 200) });
  }
);

await server.connect(new StdioServerTransport());
