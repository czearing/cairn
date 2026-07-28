import { expect, test } from "bun:test";
import { toolEntityObservations } from "../src/core/telemetry-tool-entities";

test("no-match skill selection is not counted as a selected skill", () => {
  expect(toolEntityObservations(
    "skill_select",
    { ids: ["none"] },
    { selected: [], noMatch: true },
    [],
  )).toEqual([]);
});

test("durable skill selections remain observable", () => {
  expect(toolEntityObservations(
    "skill_select",
    { ids: ["software implementation"] },
    { selected: [{ id: "skill-id" }] },
    ["skill-id"],
  )).toEqual([{
    kind: "skill_selected",
    entityType: "skill",
    entityId: "software implementation",
  }]);
});
