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

// Calls without a host session id retain the legacy path for direct unit tests and non-Copilot callers.
// Production Copilot hooks always pass sessionId and therefore never share this file.
const path = (sessionId = ""): string => sessionId
  ? join(
      dirname(process.env.CAIRN_DB_PATH || config.dbPath),
      "contracts",
      `${createHash("sha256").update(sessionId).digest("hex")}.json`,
    )
  : join(dirname(process.env.CAIRN_DB_PATH || config.dbPath), "contract.json");

export function readContract(sessionId = ""): Contract | null {
  try {
    return JSON.parse(readFileSync(path(sessionId), "utf8")) as Contract;
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

// Not every criterion can be a command — no shell decides whether a poem was written. Such a criterion is
// closed by naming the artifact that satisfies it, which is an explicit act the turn must perform; a turn
// cannot drift into offering to do the work while it still owes one.
export function satisfyCriterion(check: string, evidence: string, sessionId = ""): { error?: string; remaining?: string[] } {
  const contract = readContract(sessionId);
  if (!contract) return { error: "no contract is declared for this task" };
  const wanted = normalize(check).toLowerCase();
  const match = contract.criteria.find((criterion) => normalize(criterion.check).toLowerCase() === wanted);
  if (!match) return { error: `no declared criterion matches: ${normalize(check)}` };
  if (!normalize(evidence)) return { error: "evidence is required: name the artifact that satisfies this" };
  const criteria = contract.criteria.map((criterion) =>
    criterion === match ? { ...criterion, passed: true, evidence: normalize(evidence) } : criterion);
  write({ ...contract, criteria }, sessionId);
  return { remaining: criteria.filter((criterion) => !criterion.passed).map((criterion) => criterion.check) };
}

export function noteContractNudge(sessionId = ""): void {
  const contract = readContract(sessionId);
  // Count the nudge even when nothing is declared. Previously this no-opped without a contract, so the
  // "declare your contract" block below could never reach the cap and repeated forever — an unbounded
  // loop for any session that CANNOT declare one, e.g. an MCP client whose tool list was negotiated
  // before the `contract` tool existed. A gate whose instrument is absent must expire, not brick.
  write(contract ? { ...contract, nudges: contract.nudges + 1 } : { criteria: [], nudges: 1 }, sessionId);
}

/** Declared means at least one criterion exists; a bare nudge counter is not a declaration. */
export function contractDeclared(sessionId = ""): boolean {
  return (readContract(sessionId)?.criteria.length ?? 0) > 0;
}

/** The turn has been asked enough times; stop denying so an unusable gate cannot brick the session. */
export function contractExhausted(sessionId = ""): boolean {
  const contract = readContract(sessionId);
  return !!contract && contract.nudges > cap();
}

/**
 * The stop verdict. One rule: block while the turn has declared nothing, or still owes a criterion.
 * `changedDurableState` is accepted for call-site compatibility and deliberately unused — see
 * recordObservedRun for why forcing a falsifiable check onto every task made real tasks worse.
 */
export function contractStopReason(_changedDurableState = false, sessionId = ""): string {
  const contract = readContract(sessionId);
  if (contract && contract.nudges > cap()) return "";
  if (!contract?.criteria.length) {
    return "Before ending this turn, declare what done means for it: call the `contract` tool with the"
      + " criteria this task must meet, then satisfy each one. Do not end by offering to do the work.";
  }
  const unmet = contract.criteria.filter((criterion) => !criterion.passed).map((criterion) => criterion.check);
  const atCap = contract.nudges === cap();
  if (unmet.length) {
    // At the cap an unmeetable criterion leaves as named evidence rather than as a vague "I could not".
    return atCap
      ? `Your contract still has unmet criteria after ${cap()} attempts: ${unmet.join(" | ")}. For each one,`
        + " report exactly what you did, its output, and the specific decision it needs from the user."
      : `Not done. These declared criteria are unmet: ${unmet.join(" | ")}. Do the work that meets them,`
        + " then record each with the `contract` tool. Do not ask whether to continue.";
  }
  return "";
}

// ---------------------------------------------------------------------------------------------------
// Instrument check: is the `contract` tool actually reachable from THIS session?
//
// A client negotiates its tool list once, when the session starts, exactly as a host loads its hook
// config once (see unannouncedTools). A session that began before the `contract` tool shipped therefore
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
interface NudgeLedger { nudges: number; turns: number[]; reported: boolean }

const EMPTY_LEDGER: NudgeLedger = { nudges: 0, turns: [], reported: false };
const ledgerPath = (sessionId: string): string => sessionStatePath(sessionId, "cairn-contract-nudges.json");

function readLedger(sessionId: string): NudgeLedger {
  if (!sessionId) return EMPTY_LEDGER;
  try {
    const parsed = JSON.parse(readFileSync(ledgerPath(sessionId), "utf8")) as Partial<NudgeLedger>;
    return {
      nudges: Number(parsed.nudges) || 0,
      turns: Array.isArray(parsed.turns) ? parsed.turns.filter((t) => typeof t === "number") : [],
      reported: parsed.reported === true,
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

/** Declaring even once proves the tool is reachable, so the evidence of absence is discarded. */
export function clearInstrumentDoubt(sessionId: string): void {
  if (sessionId) rmSync(ledgerPath(sessionId), { force: true });
}

export const CONTRACT_UNAVAILABLE_REASON =
  "The `contract` tool is not reachable from this session: Cairn has asked for a contract across several"
  + " turns and no declaration has ever arrived. A client negotiates its tool list when the session starts,"
  + " so a session older than the tool can never call it and cannot fix that itself. Stop trying to call it."
  + " Cairn is releasing this gate for the rest of this session; state your completion criteria and their"
  + " evidence directly in your reply instead. Tell the user, in your reply, that this session predates the"
  + " `contract` tool and that a new session is required for the completion gate to apply.";

export function formatPlanSummary(sessionId = ""): string {
  const contract = readContract(sessionId);
  if (!contract || !contract.criteria.length) return "No active plan.";
  return contract.criteria
    .map((c) => `- [${c.passed ? "x" : " "}] ${c.check}${c.evidence ? ` (Evidence: ${c.evidence})` : ""}`)
    .join("\n");
}

export const CONTRACT_DECLARE_REASON =
  "Declare your plan first: call the `plan` (or `contract`) tool with the tasks defining done for this task."
  + " The requested side effect was not executed.";
