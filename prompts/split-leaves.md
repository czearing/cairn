Some answered nodes are not atomic: their answers are lists or multi-sentence syntheses. Those are not leaves.
Find them with brain_search, and split each into single-fact children linked to that node by its id. Do not finish while any answer is still a list or a synthesis.
