// Split a combined master prompt (a rationale paragraph followed by a numbered step list) into the
// reviewer-only explanation and the doer instructions. Used by the one-time migration of older skills,
// where both parts were stored together in master_prompt. Pure and testable.

/** Returns {explanation, instructions} split at the first numbered step line, or null when the master has
 *  no numbered list to split on. An explanation may come back empty (a steps-only master). */
export function splitMaster(master: string): { explanation: string; instructions: string } | null {
  const m = master.match(/^[ \t]*\d+[.)]\s/m); // first line that begins a numbered step
  if (!m || m.index === undefined) return null;
  return { explanation: master.slice(0, m.index).trim(), instructions: master.slice(m.index).trim() };
}
