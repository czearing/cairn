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

test("extractRunCopilot pulls request, output, and tool sequence from the current turn", () => {
  const p = events([
    userMsg("write me a haiku"),
    toolStart("cairn-brain_search"),
    asstMsg("Here is a haiku about spring."),
  ]);
  const run = extractRunCopilot(p);
  expect(run?.request).toBe("write me a haiku");
  expect(run?.output).toContain("haiku about spring");
  expect(run?.transcript).toContain("[tool] cairn-brain_search");
});

test("extractRunCopilot scopes to the LAST user turn, ignoring an earlier task", () => {
  const p = events([
    userMsg("first task"),
    asstMsg("first answer"),
    userMsg("second task"),
    asstMsg("second answer"),
  ]);
  const run = extractRunCopilot(p);
  expect(run?.request).toBe("second task");
  expect(run?.output).toBe("second answer");
  expect(run?.output).not.toContain("first answer");
});

test("extractRunCopilot returns null when there is no deliverable", () => {
  expect(extractRunCopilot(events([userMsg("a task with no reply")]))).toBeNull();
});

test("extractRunCopilot returns null on a missing file", () => {
  expect(extractRunCopilot("C:/nope/does-not-exist.jsonl")).toBeNull();
});
