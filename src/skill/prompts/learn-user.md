Grade the OUTPUT, then rewrite the skill's master prompt from everything you have reviewed (best runs first).

{{focus}}
REQUEST: {{request}}

CURRENT MASTER (the instructions a doer loads now; refine these, do not rewrite blind):
{{currentMaster}}

CURRENT EXPLANATION (the prior reviewer's rationale, written for you to reference; build on it):
{{currentExplanation}}

PRIOR RUNS (best first):
{{priors}}

RUN PROCESS (context for grading — the whole session's user messages with timestamps, the skills loaded this cycle, and the full ordered process SINCE THE LAST REVIEW with timestamps and tool calls; use it to see the guidance given, where the agent struggled or was corrected, and fold any revealed gap into the master):
{{transcript}}

NEW OUTPUT (everything the agent produced this turn; grade the actual deliverable within it and ignore process/bookkeeping chatter. If the agent never produced the deliverable the request asked for, that is a core-constraint failure):
{{output}}
