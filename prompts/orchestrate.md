You're delegating to subagents, which run in isolated contexts and can't see each other — so they
overlap or redo work unless you coordinate up front. Use the brain to keep them disjoint:

- Split the goal into non-overlapping pieces, and create one brain node per piece as that subagent's scope.
- Give each `cairn` subagent its node, and have it search the brain first, then record its findings under that node.
- Synthesize from the nodes they write, so no two agents cover the same ground.

When a subagent hands back a finished, reusable deliverable (a story, a review, a fix), call `skill_review` once it has RETURNED — not while it is still running — so the completed work, not a "still running" status, is what gets reviewed and learned.
