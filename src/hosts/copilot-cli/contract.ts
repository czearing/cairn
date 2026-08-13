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
// One file, no session key: the MCP server (which never learns a session id) must read the same contract
// the hooks write, so both resolve it from the brain's directory.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
const path = (): string => join(dirname(config.dbPath), "contract.json");
const normalize = (text: string): string => text.replace(/\s+/g, " ").trim();

export function readContract(): Contract | null {
  try {
    return JSON.parse(readFileSync(path(), "utf8")) as Contract;
  } catch {
    return null;
  }
}

function write(contract: Contract): void {
  mkdirSync(dirname(path()), { recursive: true });
  writeFileSync(path(), JSON.stringify(contract));
}

export function clearContract(): void {
  rmSync(path(), { force: true });
}

/**
 * Ratchet, not a freeze: a later call may ADD criteria but can never remove, reword, or reset an existing
 * one. Adding only ever increases the obligation, so it cannot be used to weaken the contract — while a
 * hard freeze created a live dead end, where a turn told to produce a failing check could not declare one.
 */
export function declareContract(checks: string[]): { error?: string; criteria?: Criterion[] } {
  const existing = readContract();
  const known = new Set((existing?.criteria ?? []).map((criterion) => normalize(criterion.check)));
  const added = [...new Set(checks.map(normalize).filter(Boolean))]
    .filter((check) => !known.has(check))
    .map((check) => ({ check, passed: false, failedFirst: false, evidence: "" }));
  const criteria = [...(existing?.criteria ?? []), ...added];
  if (!criteria.length) return { error: "declare at least one criterion describing what done means" };
  write({ criteria, nudges: existing?.nudges ?? 0 });
  return { criteria };
}

// Executable criteria satisfy themselves: an observed successful run of the declared check closes it.
// An earlier draft also demanded every criterion be seen FAILING first ("red before green"). Two live
// sessions proved that wrong: asked for a haiku, the agent spent six minutes manufacturing a negative
// control, which itself counted as a durable change and fed the demand, and it never delivered the poem.
// Falsifiability is a property of a good criterion, not something a gate can force onto every task.
export function recordObservedRun(command: string, succeeded: boolean): void {
  const contract = readContract();
  if (!contract || !command.trim()) return;
  const executed = normalize(command);
  let changed = false;
  const criteria = contract.criteria.map((criterion) => {
    if (!executed.includes(criterion.check)) return criterion;
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
  if (changed) write({ ...contract, criteria });
}

// Not every criterion can be a command — no shell decides whether a poem was written. Such a criterion is
// closed by naming the artifact that satisfies it, which is an explicit act the turn must perform; a turn
// cannot drift into offering to do the work while it still owes one.
export function satisfyCriterion(check: string, evidence: string): { error?: string; remaining?: string[] } {
  const contract = readContract();
  if (!contract) return { error: "no contract is declared for this task" };
  const wanted = normalize(check);
  const match = contract.criteria.find((criterion) => normalize(criterion.check) === wanted);
  if (!match) return { error: `no declared criterion matches: ${wanted}` };
  if (!normalize(evidence)) return { error: "evidence is required: name the artifact that satisfies this" };
  const criteria = contract.criteria.map((criterion) =>
    criterion === match ? { ...criterion, passed: true, evidence: normalize(evidence) } : criterion);
  write({ ...contract, criteria });
  return { remaining: criteria.filter((criterion) => !criterion.passed).map((criterion) => criterion.check) };
}

export function noteContractNudge(): void {
  const contract = readContract();
  // Count the nudge even when nothing is declared. Previously this no-opped without a contract, so the
  // "declare your contract" block below could never reach the cap and repeated forever — an unbounded
  // loop for any session that CANNOT declare one, e.g. an MCP client whose tool list was negotiated
  // before the `contract` tool existed. A gate whose instrument is absent must expire, not brick.
  write(contract ? { ...contract, nudges: contract.nudges + 1 } : { criteria: [], nudges: 1 });
}

/** Declared means at least one criterion exists; a bare nudge counter is not a declaration. */
export function contractDeclared(): boolean {
  return (readContract()?.criteria.length ?? 0) > 0;
}

/** The turn has been asked enough times; stop denying so an unusable gate cannot brick the session. */
export function contractExhausted(): boolean {
  const contract = readContract();
  return !!contract && contract.nudges > cap();
}

/**
 * The stop verdict. One rule: block while the turn has declared nothing, or still owes a criterion.
 * `changedDurableState` is accepted for call-site compatibility and deliberately unused — see
 * recordObservedRun for why forcing a falsifiable check onto every task made real tasks worse.
 */
export function contractStopReason(_changedDurableState = false): string {
  const contract = readContract();
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

export const CONTRACT_DECLARE_REASON =
  "Declare your contract first: call the `contract` tool with the criteria that define done for this task."
  + " The requested side effect was not executed.";
