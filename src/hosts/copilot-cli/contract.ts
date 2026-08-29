// Always-on completion loop. One rule, no task-specific knowledge anywhere in this file: a turn declares
// what "done" means for ITSELF, and the stop gate refuses to release the turn while any declared
// criterion is unmet. Nothing here knows what a haiku, a build, or a repository is.
//
// Earlier drafts hardcoded three lists — banned "unfalsifiable" commands, prose file extensions, and
// English deferral phrases like "would you like me to". Every one was a guess about the shape of the task,
// so every one breaks on the next task shaped differently. All are deleted: red-before-green below
// subsumes the command denylist (a check that never fails can never satisfy), and a universal
// declare-then-satisfy loop subsumes the phrase matching (a turn cannot trail off into an offer while it
// still owes an unmet criterion).
//
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { config } from "../../core/config";
import { verifyPlanEvidence } from "./reviewer";

export interface Criterion {
  check: string;
  passed: boolean;
  /** Observed failing at least once: the only proof a check can detect its own subject at all. */
  failedFirst: boolean;
  /** What satisfied it — an observed command, or the artifact the agent pointed at. */
  evidence: string;
}
interface Contract {
  criteria: Criterion[];
  nudges: number;
}

// Bounds the loop: a criterion that cannot be met must not spin forever. Mirrors STOP_CAP.
const cap = (): number => Math.max(1, Number(process.env.CAIRN_CONTRACT_CAP || "3"));
const normalize = (text: string): string => text.replace(/\s+/g, " ").trim();

/** Per-session scratch used for hook-only ledgers. */
export const sessionStatePath = (sessionId: string, file: string): string =>
  join(process.env.COPILOT_HOME || join(homedir(), ".copilot"), "session-state", sessionId || "default", file);

const effectiveSessionId = (sessionId = ""): string =>
  sessionId || process.env.CAIRN_SESSION_ID || readActiveSession() || process.env.COPILOT_SESSION_ID || "";

// The MCP server is a separate, long-lived process: it captures COPILOT_SESSION_ID once at spawn and never
// sees it change, so after the host starts a new session the `plan` tool kept writing to the previous
// session's contract. It answered "accepted" while the stop gate, which is handed the live session id by the
// hook, went on enforcing criteria that nothing could close — a turn blocked forever on work already done.
// The hook knows the live id on every event, so it publishes it here for processes that cannot be told.
const activeSessionPath = (): string =>
  join(dirname(process.env.CAIRN_DB_PATH || config.dbPath), "contracts", "active-session");

function readActiveSession(): string {
  try {
    return readFileSync(activeSessionPath(), "utf8").trim();
  } catch {
    return "";
  }
}

export function noteActiveSession(sessionId: string): void {
  if (!sessionId.trim() || readActiveSession() === sessionId.trim()) return;
  try {
    mkdirSync(dirname(activeSessionPath()), { recursive: true });
    writeFileSync(activeSessionPath(), sessionId.trim());
  } catch {
    /* best effort: a stale pointer only restores the previous fallback */
  }
}

// Calls without a host session id retain the legacy path for direct unit tests and non-Copilot callers.
// Production Copilot hooks always pass sessionId and therefore never share this file.
const path = (sessionId = ""): string => {
  const sid = effectiveSessionId(sessionId);
  return sid
    ? join(
        dirname(process.env.CAIRN_DB_PATH || config.dbPath),
        "contracts",
        `${createHash("sha256").update(sid).digest("hex")}.json`,
      )
    : join(dirname(process.env.CAIRN_DB_PATH || config.dbPath), "contract.json");
};

export function readContract(sessionId = ""): Contract | null {
  try {
    const raw = readFileSync(path(sessionId), "utf8").trim();
    const clean = raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw;
    return JSON.parse(clean) as Contract;
  } catch {
    return null;
  }
}

function write(contract: Contract, sessionId = ""): void {
  const target = path(sessionId);
  const dir = dirname(target);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.tmp-${process.pid}-${Date.now()}-${randomBytes(4).toString("hex")}.json`);
  try {
    writeFileSync(tmp, JSON.stringify(contract));
    renameSync(tmp, target);
  } catch (err) {
    try { rmSync(tmp, { force: true }); } catch { /* ignore */ }
    throw err;
  }
}

export function clearContract(sessionId = ""): void {
  rmSync(path(sessionId), { force: true });
}

export function hasActiveContract(sessionId = ""): boolean {
  const contract = readContract(sessionId);
  if (!contract || !Array.isArray(contract.criteria) || contract.criteria.length === 0) return false;
  // If the contract has already accumulated nudges from prior turns, it is not an active mid-turn declaration
  if (contract.nudges > 0) return false;
  return contract.criteria.some((criterion) => !criterion.passed);
}

/**
 * Ratchet, not a freeze: a later call may ADD criteria but can never remove, reword, or reset an existing
 * one. Adding only ever increases the obligation, so it cannot be used to weaken the contract — while a
 * hard freeze created a live dead end, where a turn told to produce a failing check could not declare one.
 */
export function declareContract(checks: string[], sessionId = ""): { error?: string; criteria?: Criterion[] } {
  const existing = readContract(sessionId);
  const known = new Set((existing?.criteria ?? []).map((criterion) => normalize(criterion.check).toLowerCase()));
  const added = [...new Set(checks.map(normalize).filter(Boolean))]
    .filter((check) => !known.has(normalize(check).toLowerCase()))
    .map((check) => ({ check, passed: false, failedFirst: false, evidence: "" }));
  const criteria = [...(existing?.criteria ?? []), ...added];
  if (!criteria.length) return { error: "declare at least one criterion describing what done means" };
  write({ criteria, nudges: existing?.nudges ?? 0 }, sessionId);
  return { criteria };
}

// Whether an executed command actually RAN the declared check, rather than merely mentioning it.
//
// This was `executed.includes(check)`, which any command containing the text satisfied — so the criterion
// "bun test" was closed by `echo "bun test"`, by a grep for it, or (observed live) by the very command
// that DECLARED the contract, since the declaration necessarily quotes its own checks. A proof gate whose
// proof is satisfied by naming the proof is not a gate at all, and it failed open, silently.
//
// A shell command is a sequence of commands, so the check must match one of those positions: the segment
// must BE the check, or start with it followed by an argument boundary. `bun test` therefore still closes
// on `cd repo; bun test --coverage`, but never on `echo "bun test"`, where the check sits inside an
// argument rather than at the head of a segment.
function ranCheck(executed: string, check: string): boolean {
  if (!check) return false;
  const lowerCheck = check.toLowerCase();
  return executed
    .split(/[;|]|&&/)
    .map((segment) => segment.trim().toLowerCase())
    .some((segment) => segment === lowerCheck || segment.startsWith(`${lowerCheck} `));
}

// Executable criteria satisfy themselves: an observed successful run of the declared check closes it.
// An earlier draft also demanded every criterion be seen FAILING first ("red before green"). Two live
// sessions proved that wrong: asked for a haiku, the agent spent six minutes manufacturing a negative
// control, which itself counted as a durable change and fed the demand, and it never delivered the poem.
// Falsifiability is a property of a good criterion, not something a gate can force onto every task.
export function recordObservedRun(command: string, succeeded: boolean, sessionId = ""): void {
  const contract = readContract(sessionId);
  if (!contract || !command.trim()) return;
  const executed = normalize(command);
  let changed = false;
  const criteria = contract.criteria.map((criterion) => {
    if (!ranCheck(executed, criterion.check)) return criterion;
    if (!succeeded && !criterion.passed) {
      changed = true;
      return { ...criterion, failedFirst: true };
    }
    if (succeeded && !criterion.passed) {
      changed = true;
      return { ...criterion, passed: true, evidence: `observed exit 0: ${executed}` };
    }
    return criterion;
  });
  if (changed) write({ ...contract, criteria }, sessionId);
}

const EXECUTABLE_COMMAND_PREFIX =
  /^(?:bun|node|npm|npx|cargo|pytest|python|python3|go|ctest|cmake|make|bash|sh|powershell|git)\s+/i;

// Several tool names are also ordinary English verbs, so "Make the deny message specific" and "Go through
// the failures" parsed as `make`/`go` invocations. Such a criterion could never be closed: it is not a real
// command, so no run can mark it passed, and satisfyCriterion refuses it for lacking a passing run. A shell
// invocation's next token is a subcommand, flag, or path, never a determiner, so prose is what follows.
const PROSE_SECOND_WORD =
  /^(?:the|a|an|all|any|each|every|some|no|this|that|these|those|it|its|his|her|their|our|your|my|sure|for|from|into|onto|over|through|via|with|without|about|back|out|up|down|ahead|again|and|but|or|so)$/i;

export function isExecutableCommand(check: string): boolean {
  const trimmed = normalize(check);
  if (!EXECUTABLE_COMMAND_PREFIX.test(trimmed)) return false;
  const second = trimmed.split(/\s+/)[1] ?? "";
  return !PROSE_SECOND_WORD.test(second);
}

export function validateEvidence(evidence: string): { valid: boolean; error?: string } {
  const trimmed = normalize(evidence);
  if (!trimmed) {
    return {
      valid: false,
      error: "evidence is required: specify what you did to complete this task (e.g., files modified, test output, or artifact produced)",
    };
  }
  return { valid: true };
}

export function stripTaskPrefix(text: string): string {
  let s = normalize(text).trim();
  const prefixes = ["phase", "task", "step", "item", "check"];
  const lower = s.toLowerCase();
  for (const p of prefixes) {
    if (lower.startsWith(p)) {
      const colonIdx = s.indexOf(":");
      const dashIdx = s.indexOf("-");
      const splitIdx = colonIdx !== -1 ? colonIdx : dashIdx;
      if (splitIdx !== -1 && splitIdx < 30) {
        s = s.slice(splitIdx + 1).trim();
        break;
      }
    }
  }
  if (s.length > 2 && (s[1] === "." || s[1] === ")" || s[1] === "-") && s[0] >= "0" && s[0] <= "9") {
    s = s.slice(2).trim();
  } else if (s.length > 3 && (s[2] === "." || s[2] === ")") && s[0] >= "0" && s[0] <= "9" && s[1] >= "0" && s[1] <= "9") {
    s = s.slice(3).trim();
  }
  return s;
}

export function findMatchingCriterion(check: string, criteria: Criterion[]): Criterion | undefined {
  if (!criteria || criteria.length === 0) return undefined;
  const wanted = normalize(check).toLowerCase();
  if (!wanted) return undefined;

  // 1. Exact match
  const exact = criteria.find((c) => normalize(c.check).toLowerCase() === wanted);
  if (exact) return exact;

  // 2. Numeric index (1-based, e.g. "1", "2", "3")
  const num = parseInt(wanted, 10);
  if (!isNaN(num) && num >= 1 && num <= criteria.length && String(num) === wanted) {
    return criteria[num - 1];
  }

  // 3. Exact match after stripping task prefixes (e.g. "Phase 1: ...", "1. ...")
  const strippedWanted = stripTaskPrefix(wanted).toLowerCase();
  const strippedExact = criteria.find((c) => stripTaskPrefix(c.check).toLowerCase() === strippedWanted);
  if (strippedExact) return strippedExact;

  // 4. Substring match (either direction) - only for strings of 4+ characters
  if (wanted.length >= 4 || strippedWanted.length >= 4) {
    const substring = criteria.find((c) => {
      const cLower = normalize(c.check).toLowerCase();
      const cStripped = stripTaskPrefix(c.check).toLowerCase();
      return (wanted.length >= 4 && (cLower.includes(wanted) || wanted.includes(cLower))) ||
        (strippedWanted.length >= 4 && (cStripped.includes(strippedWanted) || strippedWanted.includes(cStripped)));
    });
    if (substring) return substring;
  }

  // 5. If only 1 unmet criterion exists and wanted is generic complete
  const unmet = criteria.filter((c) => !c.passed);
  if (unmet.length === 1 && (wanted === "done" || wanted === "all" || wanted === "complete" || wanted === "completed")) {
    return unmet[0];
  }

  return undefined;
}

// Not every criterion can be a command — no shell decides whether a poem was written. Such a criterion is
// closed by naming the artifact that satisfies it, which is an explicit act the turn must perform; a turn
// cannot drift into offering to do the work while it still owes one.
export function satisfyCriterion(check: string, evidence: string, sessionId = ""): { error?: string; remaining?: string[] } {
  const contract = readContract(sessionId);
  if (!contract) return { error: "no contract is declared for this task" };
  const match = findMatchingCriterion(check, contract.criteria);
  if (!match) return { error: `no declared criterion matches: ${normalize(check)}` };
  const validation = validateEvidence(evidence);
  if (!validation.valid) return { error: validation.error };
  if (isExecutableCommand(match.check) && !match.passed) {
    return { error: `executable check "${match.check}" must be run via command execution and observe exit code 0` };
  }
  const review = verifyPlanEvidence(match.check, evidence, sessionId);
  if (!review.approved) {
    return { error: `reviewer rejected completion: ${review.reason}` };
  }
  const criteria = contract.criteria.map((criterion) =>
    criterion === match ? { ...criterion, passed: true, evidence: normalize(evidence) } : criterion);
  write({ ...contract, criteria }, sessionId);
  // Closing an item is real progress, so the turn is using the gate rather than stuck against it. Clear the
  // cross-turn budget: the cap below exists to expire an UNSATISFIABLE demand, not to ration a working one.
  clearDeclaredNudges(sessionId);
  return { remaining: criteria.filter((criterion) => !criterion.passed).map((criterion) => criterion.check) };
}

export function noteContractNudge(sessionId = ""): void {
  const contract = readContract(sessionId);
  // Also count it in the cross-turn ledger, which survives clearContract. The per-contract counter below
  // cannot bound anything on its own: hasActiveContract() treats nudges > 0 as "not a live declaration", so
  // the next user prompt deletes the file and the turn re-declares at zero. The counter therefore never
  // exceeded 1 in production and declaredCap() was unreachable — the plan gate re-armed at every turn
  // boundary and blocked forever, which is the "Queued (N)" pile-up users actually saw.
  noteDeclaredNudge(sessionId);
  // Count the nudge even when nothing is declared. Previously this no-opped without a contract, so the
  // "declare your plan" block below could never reach the cap and repeated forever — an unbounded
  // loop for any session that CANNOT declare one, e.g. an MCP client whose tool list was negotiated
  // before the `plan` tool existed. A gate whose instrument is absent must expire, not brick.
  write(contract ? { ...contract, nudges: contract.nudges + 1 } : { criteria: [], nudges: 1 }, sessionId);
}

/** Declared means at least one criterion exists; a bare nudge counter is not a declaration. */
export function contractDeclared(sessionId = ""): boolean {
  return (readContract(sessionId)?.criteria.length ?? 0) > 0;
}

// A declared plan is nagged harder than an undeclared one, because the turn chose those items itself and
// closing one is a single tool call. It is still BOUNDED: see planExhausted.
const declaredCap = (): number => Math.max(1, Number(process.env.CAIRN_PLAN_CAP || "6"));

/** The turn has been asked enough times; stop denying so an unusable gate cannot brick the session. */
export function contractExhausted(sessionId = ""): boolean {
  const contract = readContract(sessionId);
  if (!contract) return false;
  if (contract.criteria.length > 0) return declaredNudgeCount(contract, sessionId) > declaredCap();
  return contract.nudges > cap();
}

/**
 * How many times this session has been told it still owes declared items. Takes the larger of the
 * per-contract counter and the cross-turn ledger, so the bound holds whether or not the contract file
 * survived the last prompt.
 */
function declaredNudgeCount(contract: Contract, sessionId: string): number {
  return Math.max(contract.nudges, declaredNudges(sessionId));
}

/**
 * The stop verdict. One rule: block while the turn has declared nothing, or still owes an item.
 *
 * The block is BOUNDED, and the bound is counted ACROSS turns. An earlier draft returned a reason for any
 * unmet item and never consulted the nudge counter; the fix after that consulted only the counter stored on
 * the contract, which hasActiveContract() causes clearContract() to delete at the next prompt, so it never
 * exceeded 1 and the cap was unreachable. Either way a plan item the turn could not close — a stale item, an
 * item the model had stopped being able to name, an item whose satisfy call kept failing — blocked the stop
 * hook on every attempt, forever. That is the "Queued (N)" pile-up: the host re-runs the turn, the gate
 * re-blocks, nothing advances. Nagging is the point, but an unsatisfiable demand repeated without end is the
 * exact failure this gate exists to prevent, so the reminder expires after CAIRN_PLAN_CAP attempts and the
 * turn is released with its plan left visibly unmet. Closing any item re-arms the full budget.
 */
export function contractStopReason(changedDurableState = false, sessionId = ""): string {
  const contract = readContract(sessionId);
  if (!contract?.criteria.length) {
    if (contract && contract.nudges > cap()) return "";
    if (!changedDurableState) return "";
    return "Before ending this turn, declare what done means for it: call the `plan` tool with the"
      + " tasks this task must meet, then complete each one. Do not end by offering to do the work.";
  }
  if (declaredNudgeCount(contract, sessionId) > declaredCap()) return "";
  const unmet = contract.criteria.filter((criterion) => !criterion.passed).map((criterion) => criterion.check);
  if (unmet.length) {
    return `Not done. These declared plan items are unmet: ${unmet.join(" | ")}. Complete every item and mark each one done with evidence using the \`plan\` tool before ending this turn.`;
  }
  return "";
}

// ---------------------------------------------------------------------------------------------------
// Instrument check: is the `plan` tool actually reachable from THIS session?
//
// A client negotiates its tool list once, when the session starts, exactly as a host loads its hook
// config once (see unannouncedTools). A session that began before the `plan` tool shipped therefore
// cannot call it for its entire life, and nothing inside that session can fix it. The gate above cannot
// see that on its own: clearContract() wipes the per-turn file at every prompt, so `nudges` restarts at
// zero every turn and the cap re-arms forever. The result is the exact failure this whole system exists
// to prevent — an unsatisfiable demand, repeated at every turn boundary, that the user must micromanage
// around. Worse, the pre-tool gate denies every execution tool until that same counter passes the cap,
// so an otherwise healthy session is bricked at the start of each turn.
//
// Counting ACROSS turns separates the two cases behaviourally, with no tool names, no version numbers and
// no host strings: a turn that merely ignored the demand still has the tool and declares once it is told
// again, so it never accumulates a second turn's worth of refusals. A session that has burned the entire
// per-turn budget in two or more separate turns without ever declaring is missing the instrument, not
// disobeying. It is then told once, so the user hears it, and released — a gate whose instrument is
// absent must expire, not brick.
interface NudgeLedger { nudges: number; turns: number[]; reported: boolean; blocked: number; declared: number }

const EMPTY_LEDGER: NudgeLedger = { nudges: 0, turns: [], reported: false, blocked: 0, declared: 0 };
const ledgerPath = (sessionId: string): string => sessionStatePath(sessionId, "cairn-contract-nudges.json");

function readLedger(sessionId: string): NudgeLedger {
  if (!sessionId) return EMPTY_LEDGER;
  try {
    const raw = readFileSync(ledgerPath(sessionId), "utf8").trim();
    const clean = raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw;
    const parsed = JSON.parse(clean) as Partial<NudgeLedger>;
    return {
      nudges: Number(parsed.nudges) || 0,
      turns: Array.isArray(parsed.turns) ? parsed.turns.filter((t) => typeof t === "number") : [],
      reported: parsed.reported === true,
      blocked: Number(parsed.blocked) || 0,
      declared: Number(parsed.declared) || 0,
    };
  } catch {
    return EMPTY_LEDGER;
  }
}

function writeLedger(sessionId: string, ledger: NudgeLedger): void {
  try {
    mkdirSync(dirname(ledgerPath(sessionId)), { recursive: true });
    writeFileSync(ledgerPath(sessionId), JSON.stringify(ledger));
  } catch { /* the ledger only relaxes a gate, so failing to persist it must never block a turn */ }
}

/** Record one "you must declare a contract" demand that the turn ended without satisfying. */
export function noteUndeclaredNudge(sessionId: string, turnSeq: number): void {
  if (!sessionId) return;
  const ledger = readLedger(sessionId);
  writeLedger(sessionId, {
    ...ledger,
    nudges: ledger.nudges + 1,
    turns: ledger.turns.includes(turnSeq) ? ledger.turns : [...ledger.turns, turnSeq],
  });
}

/**
 * Record one execution tool denied at the pre-tool gate for want of a contract. A denied call never
 * reaches postToolUse, so the lifecycle execution counter stays zero and the turn looks read-only at
 * stop time. Without this the ledger never accumulates for the sessions it exists to release.
 */
export function noteContractBlocked(sessionId: string): void {
  if (!sessionId) return;
  const ledger = readLedger(sessionId);
  writeLedger(sessionId, { ...ledger, blocked: ledger.blocked + 1 });
}

export function contractBlockedAttempts(sessionId: string): number {
  return readLedger(sessionId).blocked;
}

/**
 * Cross-turn count of "you still owe declared items" blocks. Lives here, not on the contract, because
 * clearContract() deletes the contract at every prompt whose ledger has been nudged.
 */
export function noteDeclaredNudge(sessionId: string): void {
  const sid = effectiveSessionId(sessionId);
  if (!sid) return;
  const ledger = readLedger(sid);
  writeLedger(sid, { ...ledger, declared: ledger.declared + 1 });
}

export function declaredNudges(sessionId = ""): number {
  return readLedger(effectiveSessionId(sessionId)).declared;
}

/** Progress was made, so the demand is satisfiable after all: re-arm the full budget. */
export function clearDeclaredNudges(sessionId = ""): void {
  const sid = effectiveSessionId(sessionId);
  if (!sid) return;
  const ledger = readLedger(sid);
  if (ledger.declared !== 0) writeLedger(sid, { ...ledger, declared: 0 });
}

/** Demanded across at least two separate turns and never once satisfied: the tool is not there. */
export function contractInstrumentMissing(sessionId: string): boolean {
  const ledger = readLedger(sessionId);
  return ledger.turns.length >= 2 && ledger.nudges > cap();
}

export function contractInstrumentReported(sessionId: string): boolean {
  return readLedger(sessionId).reported;
}

export function markContractInstrumentReported(sessionId: string): void {
  if (sessionId) writeLedger(sessionId, { ...readLedger(sessionId), reported: true });
}

/**
 * Declaring even once proves the tool is reachable, so the evidence of absence is discarded.
 *
 * It must NOT discard the declared-nudge budget. This deleted the whole ledger file, and the agent-stop
 * hook calls it on every stop where a plan exists — immediately before noteContractNudge writes the
 * budget back at 1. That silently pinned the cross-turn counter to 1 forever, so CAIRN_PLAN_CAP was
 * unreachable and the plan gate still re-armed at every turn boundary. Observed as a session blocked on
 * 53 consecutive turns whose ledger on disk still read "declared": 1.
 */
export function clearInstrumentDoubt(sessionId: string): void {
  if (!sessionId) return;
  const { declared } = readLedger(sessionId);
  // Preserve the budget when there is one; otherwise remove the file exactly as before.
  if (declared > 0) writeLedger(sessionId, { ...EMPTY_LEDGER, declared });
  else rmSync(ledgerPath(sessionId), { force: true });
}

export const CONTRACT_UNAVAILABLE_REASON =
  "The `plan` tool is not reachable from this session: Cairn has asked for a plan across several"
  + " turns and no declaration has ever arrived. A client negotiates its tool list when the session starts,"
  + " so a session older than the tool can never call it and cannot fix that itself. Stop trying to call it."
  + " Cairn is releasing this gate for the rest of this session; state your completion criteria and their"
  + " evidence directly in your reply instead. Tell the user, in your reply, that this session predates the"
  + " `plan` tool and that a new session is required for the completion gate to apply.";

export function formatPlanSummary(sessionId = ""): string {
  const contract = readContract(sessionId);
  if (!contract || !contract.criteria.length) return "No active plan.";
  const unmetCount = contract.criteria.filter((c) => !c.passed).length;
  const items = contract.criteria
    .map((c) => `- [${c.passed ? "x" : " "}] ${c.check}${c.evidence ? ` (Evidence: ${c.evidence})` : ""}`)
    .join("\n");
  if (unmetCount > 0) {
    return `${items}\n\n${unmetCount} item(s) remaining. To mark an item complete, call \`plan\` with \`completed: "<task name>"\` and \`evidence: "<specific details of what you did>"\`.`;
  }
  return `${items}\n\nAll ${contract.criteria.length} planned items completed with verified evidence.`;
}

export const CONTRACT_DECLARE_REASON =
  "Declare your plan first: call the `plan` tool with the tasks defining done for this task."
  + " The requested side effect was not executed.";
