/** Finds the step numbers a receipt cites, e.g. "step 4", "steps 2, 5 and 7", "steps 3-6".
 *
 *  Hand-written on purpose. The previous pattern required whitespace immediately after "step", so the
 *  plural "steps 3" — the form receipts actually use — matched nothing, and a comma list counted only
 *  its first entry. It also threw the numbers away and returned a bare count, which left every citation
 *  unattributable to the skill it came from.
 */
export interface StepCitation {
  /** Offset of the "step"/"steps" keyword, used to attribute the citation to the nearest skill name. */
  index: number;
  /** The step numbers this one citation names, in the order written, already expanded from any range. */
  steps: number[];
}

/** A range longer than this is a typo or a false positive, not a citation. */
const MAXIMUM_RANGE = 101;
/** Step numbers beyond this belong to some other kind of number that happens to follow the word. */
const MAXIMUM_STEP = 500;

const isDigit = (ch: string): boolean => ch >= "0" && ch <= "9";
const isLetter = (ch: string): boolean => {
  const lower = ch.toLowerCase();
  return lower >= "a" && lower <= "z";
};
const isWordChar = (ch: string): boolean => isDigit(ch) || isLetter(ch) || ch === "_";
const isSpace = (ch: string): boolean => ch === " " || ch === "\t" || ch === "\r" || ch === "\n";
const isDash = (ch: string): boolean => ch === "-" || ch === "\u2013" || ch === "\u2014";

const skipSpace = (text: string, from: number): number => {
  let i = from;
  while (i < text.length && isSpace(text[i]!)) i++;
  return i;
};

/** Reads an integer at `from`. Returns null when there is no digit there. */
function readNumber(text: string, from: number): { value: number; end: number } | null {
  let i = from;
  let digits = "";
  while (i < text.length && isDigit(text[i]!)) { digits += text[i]; i++; }
  if (!digits) return null;
  const value = Number(digits);
  return Number.isSafeInteger(value) ? { value, end: i } : null;
}

/** Reads `word` at `from`, case-insensitively, only as a whole word. */
function readWord(text: string, from: number, word: string): number | null {
  const end = from + word.length;
  if (text.slice(from, end).toLowerCase() !== word) return null;
  if (end < text.length && isWordChar(text[end]!)) return null;
  return end;
}

/** Reads one number or range starting at `from`, appending each step it names to `steps`. */
function readStepRun(text: string, from: number, steps: number[]): number | null {
  const first = readNumber(text, from);
  if (!first) return null;
  let cursor = skipSpace(text, first.end);
  let last = first.value;
  let consumedRange = false;
  if (cursor < text.length && isDash(text[cursor]!)) {
    const after = readNumber(text, skipSpace(text, cursor + 1));
    if (after) { last = after.value; cursor = after.end; consumedRange = true; }
  } else {
    const afterTo = readWord(text, cursor, "to");
    const after = afterTo === null ? null : readNumber(text, skipSpace(text, afterTo));
    if (after) { last = after.value; cursor = after.end; consumedRange = true; }
  }
  if (last < first.value || last - first.value + 1 > MAXIMUM_RANGE) {
    // A backwards or absurd range is not a citation. Keep the first number, discard the rest.
    steps.push(first.value);
    return first.end;
  }
  for (let step = first.value; step <= last; step++) if (step <= MAXIMUM_STEP) steps.push(step);
  return consumedRange ? cursor : first.end;
}

/** Every step citation in `text`, in the order it appears. */
export function stepCitations(text: string): StepCitation[] {
  const lower = text.toLowerCase();
  const citations: StepCitation[] = [];
  let search = 0;
  while (search < lower.length) {
    const found = lower.indexOf("step", search);
    if (found < 0) break;
    search = found + 4;
    if (found > 0 && isWordChar(text[found - 1]!)) continue;      // "footstep", "sidestep"
    let cursor = found + 4;
    if (lower[cursor] === "s") cursor++;                          // "steps"
    if (cursor < text.length && isWordChar(text[cursor]!)) continue; // "stepping", "stepped"
    cursor = skipSpace(text, cursor);
    if (text[cursor] === ":") cursor = skipSpace(text, cursor + 1);
    const steps: number[] = [];
    while (cursor < text.length) {
      if (text[cursor] === "#") cursor = skipSpace(text, cursor + 1);
      const end = readStepRun(text, cursor, steps);
      if (end === null) break;
      cursor = end;
      // Only consume a separator when another number really follows it, so "step 3 and the plan"
      // stops cleanly instead of swallowing the rest of the sentence.
      let next = skipSpace(text, cursor);
      if (text[next] === "," || text[next] === "&") next = skipSpace(text, next + 1);
      else {
        const afterAnd = readWord(text, next, "and");
        if (afterAnd === null) break;
        next = skipSpace(text, afterAnd);
      }
      if (text[next] === "#") next = skipSpace(text, next + 1);
      const afterStep = readWord(text, next, "steps") ?? readWord(text, next, "step");
      if (afterStep !== null) next = skipSpace(text, afterStep);   // "step 3 and step 7"
      if (!isDigit(text[next] ?? "")) break;
      cursor = next;
    }
    if (steps.length) {
      citations.push({ index: found, steps: steps.filter((step) => step >= 1 && step <= MAXIMUM_STEP) });
      search = cursor;
    }
  }
  return citations.filter((citation) => citation.steps.length > 0);
}

/** Total steps cited, counting a step named twice twice — the completeness check compares this against
 *  the number of skills that owed a citation, so each mention has to count. */
export function citedStepTotal(text: string): number {
  return stepCitations(text).reduce((total, citation) => total + citation.steps.length, 0);
}

/**
 * Splits the citations across the skills named in the text.
 *
 * A citation belongs to the most recent skill title mentioned before it. That is the order receipts are
 * written in ("skill system audit steps 3, 7"). When the receipt names no skill at all and only one
 * skill was selected, every citation belongs to it — there is nothing else it could refer to. When
 * several skills were selected and none is named, the citations stay unattributed rather than being
 * guessed at, because a wrong attribution is worse than a missing one.
 */
export function citedStepsBySkill(
  text: string, skills: { id: string; title: string }[]
): { id: string; title: string; steps: number[] }[] {
  const citations = stepCitations(text);
  if (!citations.length || !skills.length) return [];
  const lower = text.toLowerCase();
  const mentions: { at: number; skill: { id: string; title: string } }[] = [];
  for (const skill of skills) {
    const needle = skill.title.trim().toLowerCase();
    if (!needle) continue;
    let from = 0;
    for (;;) {
      const at = lower.indexOf(needle, from);
      if (at < 0) break;
      mentions.push({ at, skill });
      from = at + needle.length;
    }
  }
  if (!mentions.length) {
    if (skills.length !== 1) return [];
    return [{ ...skills[0]!, steps: citations.flatMap((citation) => citation.steps) }];
  }
  mentions.sort((a, b) => a.at - b.at);
  const stepsById = new Map<string, { id: string; title: string; steps: number[] }>();
  for (const citation of citations) {
    let owner: { id: string; title: string } | null = null;
    for (const mention of mentions) {
      if (mention.at > citation.index) break;
      owner = mention.skill;
    }
    if (!owner) continue;                       // cited before any skill was named: unattributable
    const entry = stepsById.get(owner.id) ?? { ...owner, steps: [] };
    for (const step of citation.steps) if (!entry.steps.includes(step)) entry.steps.push(step);
    stepsById.set(owner.id, entry);
  }
  return [...stepsById.values()].map((entry) => ({ ...entry, steps: entry.steps.sort((a, b) => a - b) }));
}
