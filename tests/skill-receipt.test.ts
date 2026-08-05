import { expect, test } from "bun:test";
import { analyzeSkillReceipt, receiptScope } from "../src/core/skill-receipt";

const receipt = `**Cairn**
- **Root:** Done. http://localhost/node/1
- **Coverage:** Validated; nothing remains.
- **Recall:** Improves future work.
- **Skill application:** step 1 — inspected; step 2 — tested; step 3–4 — reported.
  Skill update — none, steps remained accurate.`;

test("skill receipts report content-free structural evidence", () => {
  expect(analyzeSkillReceipt(receipt, 4)).toMatchObject({
    present: true,
    complete: true,
    duplicate: false,
    receiptCount: 1,
    skillApplicationCount: 1,
    expectedSteps: 4,
    reportedSteps: 4,
    updateDispositionPresent: true,
  });
});

test("a receipt citing one step per selected skill is complete", () => {
  // Regression: the requirement used to be the master's full step count, which no real receipt ever
  // met — 0 of 97 checked receipts passed whenever a skill was selected.
  expect(analyzeSkillReceipt(`**Cairn**
- **Root** — Done.
- **Coverage** — Complete.
- **Recall** — Stored.
- **Skill application** — step 7 — applied the root fix.
  **Skill update** — none needed.`, 1)).toMatchObject({
    complete: true,
    expectedSteps: 1,
    reportedSteps: 1,
  });
});

test("skill receipts detect missing steps and duplicate sections", () => {
  const duplicate = `${receipt}\n\n${receipt}`;
  expect(analyzeSkillReceipt(duplicate, 5)).toMatchObject({
    complete: false,
    duplicate: true,
    receiptCount: 2,
    skillApplicationCount: 1,
    reportedSteps: 4,
  });
});

test("no-match receipts need no numbered steps", () => {
  expect(analyzeSkillReceipt(`**Cairn**
- **Root:** Done.
- **Coverage:** Complete.
- **Recall:** Stored.
- **Skill application:** none — no catalog skill fit.`, 0)).toMatchObject({
    complete: true,
    expectedSteps: 0,
    reportedSteps: 0,
    updateDispositionPresent: true,
  });
});

test("receipts accept the documented dash-separated format", () => {
  expect(analyzeSkillReceipt(`**Cairn**
- **Root** — Done.
- **Coverage** — Complete.
- **Recall** — Stored.
- **Skill application** — step 1 — applied.
  **Skill update** — none needed.`, 1)).toMatchObject({
    complete: true,
    skillApplicationCount: 1,
    reportedSteps: 1,
    updateDispositionPresent: true,
  });
});

test("step coverage counts repeated numbering across multiple skills", () => {
  expect(analyzeSkillReceipt(`**Cairn**
- **Root** — Done.
- **Coverage** — Complete.
- **Recall** — Stored.
- **Skill application** — skill A step 1 — searched; step 2 — applied.
  Skill B step 1 — inspected; step 2 — validated.
  **Skill update** — none needed.`, 4)).toMatchObject({
    complete: true,
    expectedSteps: 4,
    reportedSteps: 4,
  });
});

test("step mentions outside the Cairn receipt do not satisfy coverage", () => {
  expect(analyzeSkillReceipt(`Implemented step 1 and step 2 in the main response.

**Cairn**
- **Root** — Done.
- **Coverage** — Complete.
- **Recall** — Stored.
- **Skill application** — omitted.
  **Skill update** — none needed.`, 2)).toMatchObject({
    complete: false,
    reportedSteps: 0,
  });
});

test("later response sections do not complete an incomplete Cairn receipt", () => {
  expect(analyzeSkillReceipt(`**Cairn**
- **Root** — Done.
- **Coverage** — Complete.
- **Recall** — Stored.
- **Skill application** — omitted.

## Notes
Step 1 was discussed here.
Skill update — none needed.`, 1)).toMatchObject({
    complete: false,
    reportedSteps: 0,
    updateDispositionPresent: false,
  });
});


test("receiptScope reads the reply, not the whole turn", () => {
  // Cairn's continuation prompts are system envelopes, so a turn holds every reply since the last human
  // message. Each reply carries the receipt Cairn required of it; the turn must not read that as cheating.
  const replies = [receipt, "Interim progress note with no receipt.", receipt];
  const turn = analyzeSkillReceipt(replies.join("\n\n"), 4);
  expect(turn.receiptCount).toBe(2);
  expect(turn.duplicate).toBe(true);            // what the turn-scoped check saw
  const scoped = analyzeSkillReceipt(receiptScope(replies), 4);
  expect(scoped.receiptCount).toBe(1);
  expect(scoped.duplicate).toBe(false);
  expect(scoped.complete).toBe(true);
});

test("receiptScope skips a trailing note and still finds the receipt", () => {
  const replies = [receipt, "Pushed. Anything else?"];
  expect(analyzeSkillReceipt(receiptScope(replies), 4).complete).toBe(true);
});

test("receiptScope reports an absent receipt when no reply carried one", () => {
  expect(analyzeSkillReceipt(receiptScope(["did the work", "pushed it"]), 4).present).toBe(false);
});

test("two receipts inside ONE reply are still a duplicate", () => {
  // The rule keeps its teeth: this is the misbehavior it was written to catch.
  const doubled = `${receipt}\n\n${receipt}`;
  expect(analyzeSkillReceipt(receiptScope([doubled]), 4).duplicate).toBe(true);
});
