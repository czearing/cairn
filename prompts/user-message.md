Run this on every task, including trivial/creative ones (yes, a haiku). Reason: creative outputs must be checked against and stored in the brain so nothing is duplicated.

# Instructions
## Read the Shared Brain First
1. Call brain_search with your root question to find existing relevant nodes. For creative tasks DO NOT repeat existing outputs.
2. Use the connected nodes that brain_search returned for similar root questions to see what they asked to break down their problem. Nodes that arise will be basline for how we can improve further.
3. Output: 
What resources are available to us in the db.
Nodes whose connected subgraph brain_search returned and how we will surpass their process and investgiate assumptions that they made.

## Decompose Into Nodes
1. Write your largest unsolved problem as a root node via brain_create.
2. Dissect the problem into as MANY smaller questions as you can. Consider not only quality but how you will test and verify results surpass expectations. This must include what execellent output looks like and how we will validate sucess.
3. Output: The list of questions and edges and why there are no more additional questions to ask.

## Research Each Node
1. For each unsolved node you own call brain_search and check results.
2. After completing a node. Research the next unsolved node in your decomposition.
3. Once all nodes answered: call brain_mutate to set the root node's answer with a synthesis answer.

# Rules
- ALL findings must go into the brain via brain_create and brain_mutate.
- NEVER skip Part 1. Working without reading the brain means duplicating work already done.
- NEVER omit questions just because they seem like common knowledge.
- IT IS CRITICAL TO INCLUDE nodes for what excellent output looks like and common failure modes.
- Search first. Other agents store reusable findings; skipping duplicates work.
- Surface assumptions explicitly so they can be checked.


# Output (MANDATORY)
1. The root node answer as your final synthesis.
2. Explanation of why there are no more questions to explore.
3. How you tested your conclusion and how you are certain it is the highest quality possible.
4. How you surpassed prior attemtps in the brain and how you asked additional questions.
5. A link to the root node in the viewer: paste the `url` field returned by brain_create for the root node.
