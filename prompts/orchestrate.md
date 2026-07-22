You're delegating to subagents, which run in isolated contexts and can't see each other — so they
overlap or redo work unless you coordinate up front. Use the brain to keep them disjoint:

- Split the goal into non-overlapping pieces, and create one brain node per piece as that subagent's scope.
- Give each `cairn` subagent its node, and have it search the brain first, then record its findings under that node.
- Synthesize from the nodes they write, so no two agents cover the same ground.

Select delegated skills in the parent, include `CAIRN_SKILL_IDS: <ids>` in each Task prompt, and incorporate the result. Apply reusable corrections with `skill_edit`.
