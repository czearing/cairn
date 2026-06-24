// Pure unit tests for search-result neighbor context: prior/next question resolution and its size
// bound (the "no bloat" guarantee). No db.
import { test, expect } from "bun:test";
import { firstLine, neighborContext } from "../src/mcp/context";
import type { NodeRef } from "../src/core/neurons";

const ref = (id: string, text: string, rowid: number): NodeRef => ({ id, text, rowid });
const mapOf = (...rs: NodeRef[]) => new Map(rs.map((r) => [r.id, r]));

test("firstLine trims to the first line and bounds length", () => {
  expect(firstLine("one\ntwo", 140)).toBe("one");
  expect(firstLine("   spaced   ", 140)).toBe("spaced");
  const out = firstLine("x".repeat(200), 140);
  expect(out.length).toBe(140);
  expect(out.endsWith("…")).toBe(true);
});

test("prior = parent question, next = child question (direction from rowid)", () => {
  const refs = mapOf(
    ref("root", "How do I brew espresso?", 1),
    ref("hit", "What grind size suits espresso?", 5),
    ref("child", "What pressure suits espresso?", 9),
  );
  const ctx = neighborContext({ id: "hit", edges: ["root", "child"] }, refs);
  expect(ctx.prior).toBe("How do I brew espresso?");
  expect(ctx.next).toBe("What pressure suits espresso?");
});

test("picks the NEAREST neighbor on each side, not the farthest", () => {
  const refs = mapOf(
    ref("far-prior", "far earlier", 1),
    ref("near-prior", "near earlier", 4),
    ref("hit", "the hit", 5),
    ref("near-next", "near later", 6),
    ref("far-next", "far later", 20),
  );
  const ctx = neighborContext({ id: "hit", edges: ["far-prior", "near-prior", "near-next", "far-next"] }, refs);
  expect(ctx.prior).toBe("near earlier");
  expect(ctx.next).toBe("near later");
});

test("no bloat: a hub node with many edges still yields at most prior + next", () => {
  const refs = mapOf(ref("hit", "hub", 50));
  const edges: string[] = [];
  for (let i = 0; i < 20; i++) {
    const id = `n${i}`;
    refs.set(id, ref(id, `neighbor ${i}`, i)); // all earlier than the hit (rowid 50)
    edges.push(id);
  }
  const ctx = neighborContext({ id: "hit", edges }, refs);
  expect(Object.keys(ctx).sort()).toEqual(["prior"]); // all neighbors earlier => only a prior, no next
  expect(ctx.prior).toBe("neighbor 19"); // the nearest earlier one
});

test("returns {} when the hit or its neighbors are unresolvable", () => {
  expect(neighborContext({ id: "missing", edges: ["x"] }, mapOf(ref("x", "x", 1)))).toEqual({});
  expect(neighborContext({ id: "hit", edges: ["gone"] }, mapOf(ref("hit", "hit", 1)))).toEqual({});
});
