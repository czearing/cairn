import { test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, writeFileSync, readFileSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { install } from "../src/install";
import { checks } from "../src/doctor";
import { verify } from "../src/verify";

// The installer is proven the same way the user sees it: drive `install` against a throwaway
// settings file (MCP + verify stubbed for hermeticity) and assert idempotent, non-destructive
// hook merging — plus a real end-to-end create -> recall round-trip via verify().

let settings: string;
let binDir: string;
let copilotMcp: string;
let copilotHook: string;

beforeEach(() => {
  settings = join(tmpdir(), `cairn-settings-${randomUUID()}.json`);
  binDir = mkdtempSync(join(tmpdir(), "cairn-bin-"));
  copilotMcp = join(tmpdir(), `cairn-copilot-mcp-${randomUUID()}.json`);
  copilotHook = join(tmpdir(), `cairn-copilot-hook-${randomUUID()}.json`);
  process.env.CAIRN_SETTINGS_PATH = settings;
  process.env.CAIRN_SKIP_MCP = "1";
  process.env.CAIRN_SKIP_VERIFY = "1";
  process.env.CAIRN_BIN_DIR = binDir; // keep the shim out of the real bun bin dir during tests
  process.env.CAIRN_COPILOT_MCP_PATH = copilotMcp; // keep Copilot writes off the real ~/.copilot
  process.env.CAIRN_COPILOT_HOOK_PATH = copilotHook;
});

afterEach(() => {
  for (const p of [settings, `${settings}.bak`, copilotMcp, copilotHook]) if (existsSync(p)) rmSync(p);
  rmSync(binDir, { recursive: true, force: true });
  delete process.env.CAIRN_SETTINGS_PATH;
  delete process.env.CAIRN_SKIP_MCP;
  delete process.env.CAIRN_SKIP_VERIFY;
  delete process.env.CAIRN_BIN_DIR;
  delete process.env.CAIRN_COPILOT_MCP_PATH;
  delete process.env.CAIRN_COPILOT_HOOK_PATH;
  delete process.env.CAIRN_SKIP_COPILOT;
});

const read = () => JSON.parse(readFileSync(settings, "utf8"));
const cairnGroups = (s: ReturnType<typeof read>) =>
  Object.values(s.hooks ?? {}).flat().filter((g: any) => g.hooks.some((h: any) => h.command.includes("cairn")));

test("install adds every Cairn hook, including SubagentStop for subagent learning", async () => {
  await install();
  const s = read();
  for (const ev of ["UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop", "SubagentStop"]) {
    expect(s.hooks[ev].some((g: any) => g.hooks.some((h: any) => h.command.includes("cairn")))).toBe(true);
  }
});

test("install is idempotent — a second run adds nothing", async () => {
  await install();
  const before = cairnGroups(read()).length;
  await install();
  expect(cairnGroups(read()).length).toBe(before);
});

test("install preserves pre-existing settings and writes a .bak on first change", async () => {
  writeFileSync(settings, JSON.stringify({ model: "opus", hooks: { Stop: [{ hooks: [{ type: "command", command: "echo mine" }] }] } }));
  await install();
  const s = read();
  expect(s.model).toBe("opus"); // untouched user key survives
  expect(s.hooks.Stop.some((g: any) => g.hooks[0].command === "echo mine")).toBe(true); // their hook survives
  expect(existsSync(`${settings}.bak`)).toBe(true); // backup made before editing
});

test("uninstall removes every Cairn hook it added", async () => {
  const { uninstall } = await import("../src/uninstall");
  await install();
  expect(cairnGroups(read()).length).toBeGreaterThan(0);
  await uninstall();
  expect(cairnGroups(read()).length).toBe(0);
});

test("install creates a global cairn shim in CAIRN_BIN_DIR", async () => {
  await install();
  const isWin = process.platform === "win32";
  const shim = join(binDir, isWin ? "cairn.cmd" : "cairn");
  expect(existsSync(shim)).toBe(true);
  expect(readFileSync(shim, "utf8")).toContain("cli.ts"); // shim invokes the CLI entrypoint
});

test("install registers cairn in the Copilot mcp-config and writes the sessionStart hook", async () => {
  await install();
  const mcp = JSON.parse(readFileSync(copilotMcp, "utf8"));
  expect(mcp.mcpServers.cairn).toBeDefined();
  expect(mcp.mcpServers.cairn.type).toBe("local"); // Copilot CLI's local-stdio type
  expect(mcp.mcpServers.cairn.tools).toEqual(["*"]); // required to enable the tools
  expect(JSON.stringify(mcp.mcpServers.cairn.args)).toContain("server.ts");
  expect(mcp.mcpServers.cairn.args).not.toContain("--hot"); // stable stdio; Copilot has no Cairn cwd
  const hook = JSON.parse(readFileSync(copilotHook, "utf8"));
  expect(hook.hooks.sessionStart[0].type).toBe("command"); // workflow injected once per session
  expect(hook.hooks.userPromptSubmitted[0].type).toBe("command"); // per-turn latch reset
  expect(hook.hooks.preToolUse[0].type).toBe("command"); // brain_create deny gate
  expect(hook.hooks.preToolUse[0].matcher).toContain("brain_create"); // scoped so it never fires on ordinary tools
  expect(hook.hooks.postToolUse[0].type).toBe("command"); // per-tool reminders after brain_* / Task calls
  expect(hook.hooks.agentStop[0].type).toBe("command"); // Stop equivalent: forces a turn
  expect(hook.hooks.subagentStart[0].type).toBe("command"); // subagent-window injection
  const blob = JSON.stringify(hook);
  expect(blob).toContain("hook.ts");
  expect(blob).toContain("session-start"); // sessionStart entry carries the session-start mode arg
  expect(blob).toContain("user-prompt"); // userPromptSubmitted entry carries the user-prompt mode arg
  expect(blob).toContain("pre-tool"); // preToolUse entry carries the pre-tool mode arg
  expect(blob).toContain("post-tool"); // postToolUse entry carries the post-tool mode arg
  expect(blob).toContain("agent-stop"); // agentStop entry carries the agent-stop mode arg
  expect(blob).toContain("subagent-start"); // subagentStart entry carries the subagent-start mode arg
});

test("install Copilot setup is idempotent and preserves other MCP servers", async () => {
  writeFileSync(copilotMcp, JSON.stringify({ mcpServers: { other: { type: "local", command: "x" } } }));
  await install();
  await install();
  const mcp = JSON.parse(readFileSync(copilotMcp, "utf8"));
  expect(mcp.mcpServers.other).toBeDefined(); // user's own server untouched
  expect(mcp.mcpServers.cairn).toBeDefined();
  expect(Object.keys(mcp.mcpServers).length).toBe(2); // no duplicate cairn on the second run
});

test("CAIRN_SKIP_COPILOT skips the Copilot phase entirely", async () => {
  process.env.CAIRN_SKIP_COPILOT = "1";
  await install();
  expect(existsSync(copilotMcp)).toBe(false);
  expect(existsSync(copilotHook)).toBe(false);
  delete process.env.CAIRN_SKIP_COPILOT;
});

test("uninstall removes the Copilot cairn server and hook, keeping other servers", async () => {
  const { uninstall } = await import("../src/uninstall");
  writeFileSync(copilotMcp, JSON.stringify({ mcpServers: { other: { command: "x" } } }));
  await install();
  expect(JSON.parse(readFileSync(copilotMcp, "utf8")).mcpServers.cairn).toBeDefined();
  expect(existsSync(copilotHook)).toBe(true);
  await uninstall();
  const mcp = JSON.parse(readFileSync(copilotMcp, "utf8"));
  expect(mcp.mcpServers.cairn).toBeUndefined(); // ours removed
  expect(mcp.mcpServers.other).toBeDefined(); // theirs preserved
  expect(existsSync(copilotHook)).toBe(false); // hook file deleted
});

test("doctor reports bun and a settings-writable check", async () => {
  const list = await checks();
  expect(list.find((ck) => ck.name === "Bun runtime")?.ok).toBe(true);
  expect(list.some((ck) => ck.name === "Settings writable")).toBe(true);
});

test("verify proves a real create -> recall round-trip in an isolated DB", async () => {
  delete process.env.CAIRN_SKIP_VERIFY;
  const v = await verify();
  expect(v.recalled).toBe(true);
  expect(v.ok).toBe(true);
}, 60_000);
