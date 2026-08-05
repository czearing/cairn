import { expect, test } from "bun:test";
import { toolEntityObservations } from "../src/core/telemetry-tool-entities";

test("no-match skill selection is not counted as a selected skill", () => {
  const observations = toolEntityObservations(
    "skill_select",
    { ids: ["none"] },
    { selected: [], noMatch: true, catalogSize: 19, reason: "no_match_in_catalog" },
    [],
  );
  expect(observations.filter((row) => row.kind === "skill_selected")).toEqual([]);
});

test("an unmatched selection is recorded separately from a catalog that never arrived", () => {
  const delivered = toolEntityObservations(
    "skill_select",
    { ids: ["none"] },
    { selected: [], noMatch: true, catalogSize: 19, reason: "no_match_in_catalog" },
    [],
  ).find((row) => row.kind === "skill_selection");
  const empty = toolEntityObservations(
    "skill_select",
    { ids: ["none"] },
    { selected: [], noMatch: true, catalogSize: 0, reason: "catalog_empty" },
    [],
  ).find((row) => row.kind === "skill_selection");
  expect(delivered).toEqual({
    kind: "skill_selection",
    entityType: "skill",
    entityId: "no_match_in_catalog",
    itemCount: 19,
  });
  expect(empty).toEqual({
    kind: "skill_selection",
    entityType: "skill",
    entityId: "catalog_empty",
    itemCount: 0,
  });
});

test("durable skill selections carry the dereferenced catalog size and rank", () => {
  expect(toolEntityObservations(
    "skill_select",
    { ids: ["software implementation"] },
    { selected: [{ id: "skill-id" }], catalogSize: 19 },
    ["skill-id"],
  )).toEqual([
    {
      kind: "skill_selection",
      entityType: "skill",
      entityId: "selected",
      itemCount: 19,
    },
    {
      kind: "skill_selected",
      entityType: "skill",
      entityId: "software implementation",
      rank: 1,
      itemCount: 19,
    },
  ]);
});
