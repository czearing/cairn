The subagent is isolated from other agents, so keep its scope disjoint and give it all required context.

Before spawning, select the delegated skill in the parent and include `CAIRN_SKILL_IDS: <comma-separated ids>` in the Task prompt. The hook injects those exact steps. After the subagent returns, the parent calls `skill_review` for each id.
