import { test, expect } from "bun:test";
import { postToolFiles, stopDecision, gateDecision, isTool, STOP_CAP } from "../src/hosts/copilot-cli/hook";

// ── postToolFiles: which prompts a COMPLETED Copilot tool delivers, mirroring Claude's after-tool set ──

test("postToolFiles returns the search reminder for a brain_search", () => {
  expect(postToolFiles("cairn-brain_search", "")).toEqual(["search-results.md"]);
});

test("postToolFiles delivers entry-format BEFORE the create/mutate reminder (Claude parity)", () => {
  expect(postToolFiles("cairn-brain_create", "")).toEqual(["entry-format.md", "node-created.md"]);
  expect(postToolFiles("cairn-brain_mutate", "an answer")).toEqual(["entry-format.md", "answer-check.md"]); // answer set → split-check
  expect(postToolFiles("cairn-brain_mutate", "")).toEqual(["entry-format.md", "node-modified.md"]); // plain edit (node-modified is empty → dropped by caller)
});

test("postToolFiles delivers orchestrate BEFORE subtask-spawned for a subagent spawn", () => {
  expect(postToolFiles("task", "")).toEqual(["orchestrate.md", "subtask-spawned.md"]);
  expect(postToolFiles("Task", "")).toEqual(["orchestrate.md", "subtask-spawned.md"]);
  expect(postToolFiles("Agent", "")).toEqual(["orchestrate.md", "subtask-spawned.md"]);
});

test("postToolFiles is empty for unrelated tools", () => {
  expect(postToolFiles("view", "")).toEqual([]);
  expect(postToolFiles("bash", "")).toEqual([]);
});

// ── stopDecision: the agentStop gate, bounded so it can never loop forever ────────────────────────

test("stopDecision nudges turn-reminder when the brain was not used this turn", () => {
  expect(stopDecision({ brainUsed: false, skillUsed: false, reviewed: false, stopNudges: 0 })).toEqual({ file: "turn-reminder.md" });
});

test("stopDecision nudges skill-review when a skill was used but not reviewed before ending", () => {
  expect(stopDecision({ brainUsed: true, skillUsed: true, reviewed: false, stopNudges: 0 })).toEqual({ file: "skill-review.md" });
});

test("stopDecision allows the turn to end when the skill was reviewed", () => {
  expect(stopDecision({ brainUsed: true, skillUsed: true, reviewed: true, stopNudges: 0 })).toEqual({ file: "" });
});

test("stopDecision allows the turn to end when no skill was used", () => {
  expect(stopDecision({ brainUsed: true, skillUsed: false, reviewed: false, stopNudges: 0 })).toEqual({ file: "" });
});

test("stopDecision stops nudging once the per-turn cap is reached (no infinite loop)", () => {
  expect(stopDecision({ brainUsed: false, skillUsed: true, reviewed: false, stopNudges: STOP_CAP })).toEqual({ file: "" });
});

// ── gateDecision: the preToolUse brain_create gate (pure; deps injected) ──────────────────────────

test("gateDecision denies a node linked only to the root while open branches remain", () => {
  const d = gateDecision("cairn-brain_create", { text: "How does X work?", edges: ["r"] }, { rootId: "r", openBranch: true });
  expect(d.deny).toBe(true);
  expect(d.reason).toContain("root already has open branches");
});

test("gateDecision allows a deeper node (linked under a non-root parent)", () => {
  const d = gateDecision("cairn-brain_create", { text: "How does X work?", edges: ["child"] }, { rootId: "r", openBranch: true });
  expect(d.deny).toBe(false);
});

test("gateDecision allows a root-child when no open branches remain", () => {
  const d = gateDecision("cairn-brain_create", { text: "How does X work?", edges: ["r"] }, { rootId: "r", openBranch: false });
  expect(d.deny).toBe(false);
});

test("gateDecision never gates a non-create tool", () => {
  expect(gateDecision("cairn-brain_mutate", { text: "x" }, { rootId: "r", openBranch: true }).deny).toBe(false);
  expect(gateDecision("cairn-brain_search", { text: "x" }, { rootId: "r", openBranch: true }).deny).toBe(false);
});

// ── isTool: accepts bare, hyphen-prefixed, and __-namespaced forms ────────────────────────────────

test("isTool matches across naming conventions", () => {
  expect(isTool("brain_search", "brain_search")).toBe(true);
  expect(isTool("cairn-brain_search", "brain_search")).toBe(true);
  expect(isTool("mcp__cairn__brain_search", "brain_search")).toBe(true);
  expect(isTool("view", "brain_search")).toBe(false);
});
