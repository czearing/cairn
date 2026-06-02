Node created. Do NOT emit end_turn.
Research this node and call brain_mutate to set its answer with your findings, and put the real source URL in the `citation` field.
All new nodes must rely on web fetch for the contennt. Future Claude instances will leverage this information and any inaccurate data will cause compounding confusion.
If you are referencing another node you are REQUIRED to connect it's edges via brain_mutate by adding it to edges.
