/** Host tool names arrive namespaced: "mcp__cairn__brain_search", "cairn-brain_search". Strip the
 *  namespace by locating the last "brain_"/"skill_" that a "__" or "-" separator introduces.
 *
 *  Written as an explicit scan rather than a pattern. This sits under every graded metric and every
 *  telemetry attribution, and a pattern that silently fails to match reports each dependent count as
 *  zero, which is indistinguishable from real non-compliance. */
const cairnToolPrefixes = ["brain_", "skill_"];

export function normalizeToolName(value: string): string {
  const lower = value.toLowerCase();
  let cut = 0;
  for (const prefix of cairnToolPrefixes) {
    for (let at = lower.indexOf(prefix); at > 0; at = lower.indexOf(prefix, at + 1)) {
      const separated = lower[at - 1] === "-" || (at >= 2 && lower.startsWith("__", at - 2));
      if (separated && at > cut) cut = at;
    }
  }
  return cut > 0 ? lower.slice(cut) : lower;
}

/** True for the Cairn MCP tools whose results must carry a runtime identity. */
export function isCairnToolName(value: string): boolean {
  return cairnToolPrefixes.some((prefix) => value.startsWith(prefix));
}
