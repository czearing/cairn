List the distinct reusable DELIVERABLES this finished turn produced, each with its task label, by WHAT was produced (not by what the request talks about). A turn can produce more than one (e.g. a story AND a review of that story).

EXISTING SKILLS (label: what it produces) — reuse one of these labels EXACTLY when a deliverable is the same type as that skill, else coin a new specific label:
{{existing}}

REQUEST: {{request}}

WHAT THE AGENT DELIVERED (find each distinct deliverable in here and in the process below):
{{output}}

RUN PROCESS (ordered, with tool calls and any subagent activity — a reviewer subagent's critique counts as its OWN deliverable):
{{transcript}}

Call the skill_segment tool exactly once with one {label, what} row per distinct deliverable (an empty list for a turn with no reusable deliverable).
