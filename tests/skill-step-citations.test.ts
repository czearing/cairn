import { expect, test } from "bun:test";
import { citedStepTotal, citedStepsBySkill, stepCitations } from "../src/core/skill-step-citations";

test("a plural citation with a comma list is read completely", () => {
  // The previous pattern required a space straight after "step", so "steps 3" matched nothing at all
  // and a list stopped at its first entry. Both forms are what receipts actually write.
  expect(stepCitations("applied steps 3, 5 and 9").map((c) => c.steps)).toEqual([[3, 5, 9]]);
  expect(citedStepTotal("steps 3, 5 and 9")).toBe(3);
});

test("ranges expand and both dash forms are accepted", () => {
  expect(stepCitations("step 2-4").map((c) => c.steps)).toEqual([[2, 3, 4]]);
  expect(stepCitations("steps 2\u20134").map((c) => c.steps)).toEqual([[2, 3, 4]]);
  expect(stepCitations("steps 2 to 4").map((c) => c.steps)).toEqual([[2, 3, 4]]);
});

test("repeated keywords are separate citations and a step named twice counts twice", () => {
  expect(stepCitations("step 1 then step 1 again").map((c) => c.steps)).toEqual([[1], [1]]);
  expect(citedStepTotal("step 1 then step 1 again")).toBe(2);
});

test("words that merely contain step are not citations", () => {
  expect(stepCitations("stepping 3 times, sidestep 4, footsteps 5")).toEqual([]);
});

test("a separator is only consumed when a number really follows", () => {
  expect(stepCitations("step 3 and the plan was revised").map((c) => c.steps)).toEqual([[3]]);
  expect(stepCitations("step 3 and step 7").map((c) => c.steps)).toEqual([[3, 7]]);
});

test("a backwards or absurd range keeps the first number and discards the rest", () => {
  expect(stepCitations("step 9-2").map((c) => c.steps)).toEqual([[9]]);
  expect(stepCitations("step 1-9999").map((c) => c.steps)).toEqual([[1]]);
});

test("citations are attributed to the skill named before them", () => {
  const text = "git publishing steps 2, 3; skill system audit steps 7 and 9";
  expect(citedStepsBySkill(text, [
    { id: "a", title: "git publishing" },
    { id: "b", title: "skill system audit" },
  ])).toEqual([
    { id: "a", title: "git publishing", steps: [2, 3] },
    { id: "b", title: "skill system audit", steps: [7, 9] },
  ]);
});

test("with one selected skill and no name in the text, every citation belongs to it", () => {
  expect(citedStepsBySkill("applied steps 1 and 4", [{ id: "a", title: "git publishing" }]))
    .toEqual([{ id: "a", title: "git publishing", steps: [1, 4] }]);
});

test("with several selected skills and no name, nothing is guessed", () => {
  // A wrong attribution would be reported as fact. Report nothing instead.
  expect(citedStepsBySkill("applied steps 1 and 4", [
    { id: "a", title: "git publishing" },
    { id: "b", title: "code review" },
  ])).toEqual([]);
});
