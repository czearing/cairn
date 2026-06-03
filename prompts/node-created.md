Node created. Do NOT emit end_turn.
The title of this node may only be a single question.
Create as many child nodes as possible and deeply research conclusions drawn from your research. Call brain_mutate to set its answer with your findings, and put the real source URL in the `citation` field.
All nodes must rely on web fetch for the content. Future Claude instances will leverage this information and any inaccurate data will cause compounding confusion.
If you are referencing another node you are REQUIRED to connect it's edges via brain_mutate by adding it to edges.
