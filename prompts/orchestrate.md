You're about to spawn a subagent. Subagents run in isolated contexts and can't see each other, so
duplicate work and miscommunication come from vague delegation. Orchestrate through the brain:

1. DECOMPOSE into DISJOINT subtasks — partition by file/module, question, or source so no two overlap.
   brain_create one node per subtask; that node id is its exclusive scope.
2. SPAWN each as a `cairn` subagent with a full contract: its objective, its node id as the ONLY scope
   ("do only this, not the others'"), the exact output you want back, and which tools/files to use.
   Tell each to brain_search first and record findings under its node.
3. RIGHT-SIZE: match the number of agents to complexity; run dependent steps in sequence and
   parallelize only the truly independent ones.
4. SYNTHESIZE: when they return, read the nodes they wrote (not the raw text), dedupe, resolve
   conflicts, and produce one unified result.
