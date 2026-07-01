import { test, expect } from "bun:test";
import { writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { buildArgs, capPrompt, writeLearnMcpConfig, runCopilot } from "../src/skill/copilot";
import { learnerBackend, runLearner } from "../src/skill/runner";
import { extractRunCopilot } from "../src/skill/transcript-copilot";

const after = (a: string[], flag: string) => a[a.indexOf(flag) + 1];

// ── buildArgs: classify (no brain) vs learn (brain + capture) ─────────────────────────────────────

test("buildArgs runs silent, reproducible, and tool-free for a classify call", () => {
  const a = buildArgs({ model: "gpt-5.4" });
  expect(a).toContain("-s");                         // response only, no stats
  expect(a).toContain("--no-custom-instructions");   // no AGENTS.md pollution
  expect(after(a, "--model")).toBe("gpt-5.4");
  expect(a).not.toContain("--allow-all-tools");      // no brain ⇒ no tools at all
  expect(a).not.toContain("--additional-mcp-config");
});

test("buildArgs wires the capture MCP and restricts to brain tools for a learn call", () => {
  const a = buildArgs({}, "/tmp/learn.json");
  expect(after(a, "--additional-mcp-config")).toBe("@/tmp/learn.json");
  expect(after(a, "--disable-mcp-server")).toBe("cairn"); // drop the ambient cairn (no capture env)
  expect(a).toContain("--disable-builtin-mcps");          // no github-mcp-server
  expect(a).toContain("--allow-all-tools");               // required for tool use in -p mode
  const blob = a.join(" ");
  expect(blob).toContain("--available-tools cairnlearn-skill_output"); // only the brain tools the learner needs
  expect(blob).toContain("--available-tools cairnlearn-brain_search");
  expect(a).not.toContain("--deny-tool");                 // deny-tool breaks MCP permission in -p mode
});

// ── capPrompt: protect the instructions + deliverable, drop the transcript middle ─────────────────

test("capPrompt leaves a prompt under budget untouched", () => {
  expect(capPrompt("short prompt", 1000)).toBe("short prompt");
});

test("capPrompt truncates the MIDDLE and keeps head + tail when over budget", () => {
  const p = "HEAD_INSTRUCTIONS" + "x".repeat(5000) + "TAIL_DELIVERABLE";
  const out = capPrompt(p, 400);
  expect(out.length).toBeLessThanOrEqual(400);
  expect(out.startsWith("HEAD_INSTRUCTIONS")).toBe(true);
  expect(out.endsWith("TAIL_DELIVERABLE")).toBe(true);
  expect(out).toContain("truncated");
});

// ── writeLearnMcpConfig: capture env baked into the server entry ──────────────────────────────────

test("writeLearnMcpConfig bakes the capture env into a cairnlearn server", () => {
  const path = writeLearnMcpConfig({ CAIRN_SKILL_OUTPUT_PATH: "/tmp/out.json", CAIRN_SKILL_FORCED_LABEL: "demo" });
  const cfg = JSON.parse(readFileSync(path, "utf8"));
  const srv = cfg.mcpServers.cairnlearn;
  expect(srv).toBeDefined();
  expect(srv.tools).toEqual(["*"]);
  expect(srv.env.CAIRN_SKILL_OUTPUT_PATH).toBe("/tmp/out.json");
  expect(srv.env.CAIRN_SKILL_FORCED_LABEL).toBe("demo");
  expect(srv.env.CAIRN_DB_PATH).toBeTruthy(); // points the learner at the same brain
});

// ── learnerBackend: explicit env wins; runLearner dispatches ──────────────────────────────────────

test("learnerBackend honors CAIRN_LEARN_BACKEND", () => {
  const prev = process.env.CAIRN_LEARN_BACKEND;
  try {
    process.env.CAIRN_LEARN_BACKEND = "copilot";
    expect(learnerBackend()).toBe("copilot");
    process.env.CAIRN_LEARN_BACKEND = "claude";
    expect(learnerBackend()).toBe("claude");
  } finally {
    if (prev === undefined) delete process.env.CAIRN_LEARN_BACKEND; else process.env.CAIRN_LEARN_BACKEND = prev;
  }
});

test("runLearner routes to copilot and surfaces the real failure reason", async () => {
  const prevB = process.env.CAIRN_LEARN_BACKEND, prevBin = process.env.CAIRN_COPILOT_BIN;
  process.env.CAIRN_LEARN_BACKEND = "copilot";
  process.env.CAIRN_COPILOT_BIN = "cairn-no-such-copilot-xyz"; // cannot spawn
  try {
    const r = await runLearner("hello");
    expect(r.ok).toBe(false);
    expect(r.error).toBeTruthy();              // the reason is reported, not swallowed
  } finally {
    if (prevB === undefined) delete process.env.CAIRN_LEARN_BACKEND; else process.env.CAIRN_LEARN_BACKEND = prevB;
    if (prevBin === undefined) delete process.env.CAIRN_COPILOT_BIN; else process.env.CAIRN_COPILOT_BIN = prevBin;
  }
});

test("runCopilot surfaces a spawn failure instead of throwing", async () => {
  const prev = process.env.CAIRN_COPILOT_BIN;
  process.env.CAIRN_COPILOT_BIN = "cairn-no-such-copilot-xyz";
  try {
    const r = await runCopilot("hi");
    expect(r.ok).toBe(false);
    expect(r.error).toBeTruthy();
  } finally {
    if (prev === undefined) delete process.env.CAIRN_COPILOT_BIN; else process.env.CAIRN_COPILOT_BIN = prev;
  }
});

// ── extractRunCopilot: parse Copilot events.jsonl, scoped to the current turn ─────────────────────

function events(objs: object[]): string {
  const p = join(tmpdir(), `cairn-copilot-events-${randomUUID()}.jsonl`);
  writeFileSync(p, objs.map((o) => JSON.stringify(o)).join("\n"));
  return p;
}
const userMsg = (content: string) => ({ type: "user.message", data: { content } });
const asstMsg = (content: string) => ({ type: "assistant.message", data: { content } });
const toolStart = (toolName: string) => ({ type: "tool.execution_start", data: { toolName } });
// Subagent-tagged variants: Copilot interleaves a subagent's own messages/tools in the PARENT log, keyed by agentId.
const subStart = (agentId: string, agentDisplayName: string) => ({ type: "subagent.started", agentId, data: { agentDisplayName } });
const subDone = (agentId: string) => ({ type: "subagent.completed", agentId, data: {} });
const subMsg = (agentId: string, content: string) => ({ type: "assistant.message", agentId, data: { content } });

test("extractRunCopilot pulls request, output, and tool sequence for the cycle", () => {
  const p = events([
    userMsg("write me a haiku"),
    toolStart("cairn-brain_search"),
    asstMsg("Here is a haiku about spring."),
  ]);
  const run = extractRunCopilot(p);
  expect(run?.request).toBe("write me a haiku");
  expect(run?.output).toContain("haiku about spring");
  expect(run?.transcript).toContain("TRANSCRIPT (oldest first):"); // ONE transcript section
  expect(run?.transcript).toContain("[USER] write me a haiku");
  expect(run?.transcript).toContain("[TOOL] brain_search");        // tool inline, cairn- prefix stripped
});

test("extractRunCopilot scopes the transcript to the current cycle (since the last skill_review)", () => {
  const p = events([
    userMsg("first task"),
    asstMsg("first answer"),
    { type: "tool.execution_start", data: { toolName: "cairn-skill_review", arguments: '{"label":"a"}' } }, // cycle 1 closed
    userMsg("second task"),
    asstMsg("second answer"),
    { type: "tool.execution_start", data: { toolName: "cairn-skill_review", arguments: '{"label":"b"}' } }, // cycle 2 = current
  ]);
  const run = extractRunCopilot(p);
  expect(run?.request).toBe("second task");                 // the CURRENT cycle only
  expect(run?.output).toBe("second answer");
  expect(run?.transcript).toContain("[USER] second task");
  expect(run?.transcript).not.toContain("first task");      // the earlier cycle is excluded entirely
});

test("extractRunCopilot shows tool calls inline with their skill hint (no separate section)", () => {
  const p = events([
    userMsg("fix this PR description"),
    { type: "tool.execution_start", data: { toolName: "cairn-skill_search", arguments: '{"task":"pr description"}' } },
    { type: "tool.execution_start", data: { toolName: "cairn-skill_create", arguments: '{"label":"pr description"}' } },
    asstMsg("Rewrote the description."),
  ]);
  const run = extractRunCopilot(p);
  expect(run?.transcript).toContain('[TOOL] skill_search "pr description"');
  expect(run?.transcript).toContain('[TOOL] skill_create "pr description"');
});

test("extractRunCopilot captures the model's THINKING (reasoningText) in the transcript, not just the message", () => {
  const p = events([
    userMsg("write me a haiku about frost"),
    { type: "assistant.message", data: { reasoningText: "I should ground this in a concrete winter image and avoid the cliche of 'silent snow'.", content: "First frost on the gate / the dog's breath hangs in the air / no one else awake" } },
  ]);
  const run = extractRunCopilot(p);
  expect(run?.transcript).toContain("[ASSISTANT THINKING] I should ground this"); // the thoughts are shown
  expect(run?.transcript).toContain("[ASSISTANT] First frost on the gate");        // and so is the visible message
  expect(run?.output).toContain("First frost on the gate");                        // deliverable = the message
  expect(run?.output).not.toContain("I should ground this");                       // ...not the thinking
});

test("extractRunCopilot timestamps each transcript line", () => {
  const ts = Date.UTC(2026, 6, 1, 14, 3, 9);
  const p = events([
    { type: "user.message", timestamp: ts, data: { content: "write me a haiku" } },
    { type: "assistant.message", timestamp: ts + 60000, data: { content: "first frost on the gate" } },
  ]);
  const run = extractRunCopilot(p);
  expect(run?.transcript).toContain("[14:03:09] [USER] write me a haiku"); // HH:MM:SS from the events.jsonl timestamp
});

test("extractRunCopilot returns null when there is no deliverable", () => {
  expect(extractRunCopilot(events([userMsg("a task with no reply")]))).toBeNull();
});

test("extractRunCopilot returns null on a missing file", () => {
  expect(extractRunCopilot("C:/nope/does-not-exist.jsonl")).toBeNull();
});

test("extractRunCopilot ignores a host system-envelope user message so a notification never becomes the task", () => {
  // A genuine task, then a background-task completion notification arrives as a user.message. The notification
  // must NOT anchor a new turn or pollute the request — otherwise the loop grades it and mints a junk skill.
  const p = events([
    userMsg("ship the feature PR"),
    asstMsg("Pushed and opened PR #42."),
    userMsg("<task-notification> <task-id>bzemxe7vb</task-id> <tool-use-id>toolu_01</tool-use-id> done"),
    asstMsg("Acknowledged."),
  ]);
  const run = extractRunCopilot(p);
  expect(run?.request).toBe("ship the feature PR");        // anchored on the genuine prompt, not the notification
  expect(run?.request).not.toContain("task-notification");
});

test("extractRunCopilot returns null when the only user message is a system envelope (no human task)", () => {
  const p = events([
    userMsg("<task-notification> <task-id>bly967nd5</task-id> background job finished"),
    asstMsg("I noticed the job finished."),
  ]);
  expect(extractRunCopilot(p)).toBeNull();                  // nothing the human actually asked for: skip learning
});

test("extractRunCopilot captures a subagent-produced deliverable that the main agent only narrates", () => {
  // The backgrounded-subagent bug: the main agent ends on a status line, but the STORY was written by a
  // subagent and is interleaved in the same log (agentId-tagged). The graded output must be the story.
  const p = events([
    userMsg("write me a short story"),
    asstMsg("I'll delegate the writing to a story subagent."),
    subStart("toolu_a1", "Story Writer"),
    subMsg("toolu_a1", "THE STORY: The pacemaker stepped aside at the bell and the boy behind him never knew the pace had been a gift."),
    subDone("toolu_a1"),
    asstMsg("The story subagent is finished; reconciling now."),
  ]);
  const run = extractRunCopilot(p);
  expect(run).not.toBeNull();
  expect(run!.output).toContain("THE STORY");                       // the subagent's actual deliverable is graded
  expect(run!.transcript).toContain("spawned subagent: Story Writer"); // subagent activity is captured in the log
  expect(run!.transcript).toContain("[SUBAGENT:Story Writer]");     // its message is tagged, not blended into the main agent
  expect(run!.transcript).toContain("subagent Story Writer returned");
});

test("extractRunCopilot tags a subagent's tool calls distinctly from the main agent's", () => {
  const p = events([
    userMsg("review this PR"),
    toolStart("cairn-brain_search"),                                // main agent
    subStart("toolu_b2", "Reviewer"),
    { type: "tool.execution_start", agentId: "toolu_b2", data: { toolName: "view" } }, // subagent tool
    subMsg("toolu_b2", "REVIEW: 3 real issues, 2 non-issues, each with file:line."),
    subDone("toolu_b2"),
  ]);
  const run = extractRunCopilot(p);
  expect(run!.transcript).toContain("[TOOL] brain_search");        // main-agent tool
  expect(run!.transcript).toContain("[SUBAGENT:Reviewer TOOL] view"); // subagent tool: tagged
  expect(run!.output).toContain("REVIEW: 3 real issues");          // subagent's critique is captured as output
});
