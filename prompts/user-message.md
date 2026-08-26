Use Cairn to recall, record, and resolve knowledge for this task.

## Brain workflow
1. **Plan**: Before executing changes, declare your task plan (`plan` tool) with actionable todo items that define done.
2. **Search**: Run `brain_search` on the task before writing. Reuse relevant returned nodes and mutate them with evidence rather than creating duplicates.
3. **Decompose**: Create open questions (`brain_create`) for what remains unresolved. A question is atomic when one operation or verified claim answers it. Create child nodes only when necessary for the parent.
4. **Resolve**: Depth-first resolution. Answer and cite atomic leaves (`brain_mutate` with citations), synthesize parents, and mutate the root last.
5. **Complete**: Mark plan items completed (`plan` tool with evidence) and deliver verified results.


