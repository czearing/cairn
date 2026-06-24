import { test, expect, beforeAll, beforeEach } from "bun:test";

let N: typeof import("../src/core/neurons");
let DB: typeof import("../src/core/db");

beforeAll(async () => {
  N = await import("../src/core/neurons");
  DB = await import("../src/core/db");
});
beforeEach(() => DB.db().run("DELETE FROM neurons"));

const answered = (n: { answer: string }) => n.answer.trim().length > 0;

test("create: returns a usable id and is unsolved", async () => {
  const n = await N.create("How do I write a haiku?");
  expect(n.id).toBeTruthy();
  expect(n.answer).toBe("");
  expect(n.citation).toBe("");
  expect(N.get(n.id)).toEqual(n);
});

test("mutate: sets a citation and merges it independently of content", async () => {
  const n = await N.create("Q?");
  const m = (await N.mutate(n.id, { answer: "A", citation: "https://example.com/doc" }))!;
  expect(m.citation).toBe("https://example.com/doc");
  // changing only edges must not drop the citation (and must not re-embed)
  await N.mutate(n.id, { edges: [] });
  expect(N.get(n.id)!.citation).toBe("https://example.com/doc");
});

test("create: edges dedupe and never self-reference", async () => {
  const other = await N.create("neighbor");
  const n = await N.create("root", [other.id, other.id]);
  expect(n.edges).toEqual([other.id]);
  const m = await N.mutate(n.id, { edges: [n.id, other.id] });
  expect(m!.edges).not.toContain(n.id);
});

test("create: edge mirrors so the graph is undirected", async () => {
  const a = await N.create("A");
  const b = await N.create("B", [a.id]);
  expect(N.get(a.id)!.edges).toContain(b.id);
});

const CITE = "https://src.example";

test("mutate: setting answer marks solved", async () => {
  const n = await N.create("Q?");
  expect(answered((await N.mutate(n.id, { answer: "because", citation: CITE }))!)).toBe(true);
});

test("mutate: idempotent", async () => {
  const n = await N.create("Q?");
  const a = await N.mutate(n.id, { answer: "A", text: "Q2?", citation: CITE });
  const b = await N.mutate(n.id, { answer: "A", text: "Q2?", citation: CITE });
  expect(a).toEqual(b);
});

test("mutate: partial merge keeps omitted fields", async () => {
  const n = await N.create("keep me");
  await N.mutate(n.id, { answer: "new", citation: CITE });
  const after = N.get(n.id)!;
  expect(after.text).toBe("keep me");
  expect(after.answer).toBe("new");
});

test("mutate: REJECTS an insanely long answer, asking for concision", async () => {
  const { config } = await import("../src/core/config");
  const n = await N.create("Q?");
  const tooLong = "x".repeat(config.maxAnswerChars + 1);
  expect(N.mutate(n.id, { answer: tooLong, citation: CITE })).rejects.toThrow(/too long.*concis/is);
  // exactly at the limit is allowed (the bound is generous room, not a trap)
  const ok = "x".repeat(config.maxAnswerChars);
  expect((await N.mutate(n.id, { answer: ok, citation: CITE }))!.answer.length).toBe(config.maxAnswerChars);
});

test("mutate: REQUIRES a citation when giving an answer", async () => {
  const n = await N.create("Q?");
  expect(N.mutate(n.id, { answer: "an uncited claim" })).rejects.toThrow(/citation required/);
  const m = (await N.mutate(n.id, { answer: "a cited claim", citation: CITE }))!;
  expect(m.answer).toBe("a cited claim");
});

test("link/unlink connect thoughts bidirectionally", async () => {
  const a = await N.create("A");
  const b = await N.create("B");
  N.link(a.id, b.id);
  expect(N.get(a.id)!.edges).toContain(b.id);
  expect(N.get(b.id)!.edges).toContain(a.id);
  N.unlink(a.id, b.id);
  expect(N.get(a.id)!.edges).not.toContain(b.id);
  expect(N.get(b.id)!.edges).not.toContain(a.id);
});

test("mutate: unknown id returns null", async () => {
  expect(await N.mutate("nope", { answer: "x" })).toBeNull();
});

test("remove: deletes and cleans dangling edges", async () => {
  const a = await N.create("A");
  const b = await N.create("B", [a.id]);
  expect(N.remove(b.id)).toBe(true);
  expect(N.get(b.id)).toBeNull();
  expect(N.get(a.id)!.edges).not.toContain(b.id);
});

test("remove: detaches the id from EVERY neighbor, not just one", async () => {
  const hub = await N.create("hub");
  const neighbors = await Promise.all([N.create("A"), N.create("B"), N.create("C")]);
  for (const n of neighbors) N.link(hub.id, n.id);
  expect(N.remove(hub.id)).toBe(true);
  for (const n of neighbors) expect(N.get(n.id)!.edges).not.toContain(hub.id);
});

test("remove: leaves unrelated neurons' edges intact", async () => {
  const a = await N.create("A");
  const b = await N.create("B", [a.id]);
  const victim = await N.create("victim");
  N.remove(victim.id);
  expect(N.get(a.id)!.edges).toContain(b.id);
  expect(N.get(b.id)!.edges).toContain(a.id);
});

test("all: reflects writes", async () => {
  expect(N.all().length).toBe(0);
  await N.create("one");
  await N.create("two");
  expect(N.all().length).toBe(2);
});

// Guard against the legacy corruption class: control/null bytes (binary, embedding-byte bleed)
// must never persist into a text field. Keeps tab/newline/return.
test("create/mutate: strip control and null bytes from text fields", async () => {
  const NUL = String.fromCharCode(0);
  const BIN = String.fromCharCode(2) + String.fromCharCode(27) + String.fromCharCode(0xfffd);

  const n = await N.create(`clean${NUL} text${BIN} end`);
  expect(n.text).toBe("clean text end");

  const m = (await N.mutate(n.id, {
    answer: `good${NUL} answer`,
    citation: "https://example.com/doc",
  }))!;
  expect(m.answer).toBe("good answer");
  expect(m.citation).toBe("https://example.com/doc");

  // tab, newline, and return must survive
  const TAB = String.fromCharCode(9), NL = String.fromCharCode(10), CR = String.fromCharCode(13);
  const k = await N.create("line1" + NL + "line2" + TAB + "end" + CR);
  expect(k.text).toBe("line1" + NL + "line2" + TAB + "end" + CR);
});
