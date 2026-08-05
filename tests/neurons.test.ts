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

test("mutate: REJECTS a citation naming a thought that does not exist", async () => {
  const n = await N.create("Q?");
  const fake = "b8a36170-0000-0000-0000-000000000000";
  expect(N.mutate(n.id, { answer: "claim", citation: `see ${fake}` }))
    .rejects.toThrow(/does not resolve/);
  // the real neighbour resolves, so the same shape of citation is accepted
  const real = await N.create("neighbour?");
  const m = (await N.mutate(n.id, { answer: "claim", citation: `see ${real.id}` }))!;
  expect(m.answer).toBe("claim");
});

test("mutate: REJECTS a citation naming a file that does not exist", async () => {
  const n = await N.create("Q?");
  expect(N.mutate(n.id, { answer: "claim", citation: "file:///C:/Code/cairn/src/core/nope.ts:12" }))
    .rejects.toThrow(/does not resolve/);
  const m = (await N.mutate(n.id, {
    answer: "claim",
    citation: "file:///C:/Code/cairn/src/core/citation.ts:1-10",
  }))!;
  expect(m.answer).toBe("claim");
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

// A retry that carries the id the client already minted is a duplicate DELIVERY of one create, not a
// second thought. The existence check is separated from the write by the embed await, so both calls
// clear it; the write itself must be the thing that claims the id.
test("a concurrent create with the same id yields one node instead of a constraint error", async () => {
  const id = crypto.randomUUID();
  const settled = await Promise.allSettled([
    N.createWithDuplicateCandidates("Which reverb tail needs a parametric generator?", ["a"], id),
    N.createWithDuplicateCandidates("Which reverb tail needs a parametric generator?", ["a"], id),
  ]);
  expect(settled.map((entry) => entry.status)).toEqual(["fulfilled", "fulfilled"]);
  for (const entry of settled) {
    expect((entry as PromiseFulfilledResult<{ neuron: { id: string } }>).value.neuron.id).toBe(id);
  }
  const rows = DB.db().query("SELECT id FROM neurons WHERE id=?").all(id) as unknown[];
  expect(rows.length).toBe(1);
  // The winner's content must survive; the loser must not blank the edges it also asked for.
  expect(N.get(id)?.edges).toEqual(["a"]);
});

test("a repeated create with the same id returns the stored node without a second row", async () => {
  const id = crypto.randomUUID();
  const first = await N.createWithDuplicateCandidates("How does a room decay differ from a drum tail?", [], id);
  await N.mutate(id, { answer: "Source decay is onset-synchronous.", citation: "probe" });
  const again = await N.createWithDuplicateCandidates("How does a room decay differ from a drum tail?", [], id);
  expect(again.neuron.id).toBe(first.neuron.id);
  // Replaying the create must not erase an answer recorded between the original and the retry.
  expect(again.neuron.answer).toBe("Source decay is onset-synchronous.");
  expect((DB.db().query("SELECT id FROM neurons WHERE id=?").all(id) as unknown[]).length).toBe(1);
});

// The graph is undirected by design: create mirrors every edge so a link is traversable from both
// ends. mutate did not, yet `edges` on mutate is the documented way to record reuse, so the primary
// linking path silently produced half-directed links the peer could never recall.
test("mutate mirrors a new edge onto the peer, like create does", async () => {
  const b = await N.create("Which node is the mutate mirror peer?");
  const a = await N.create("Which node sets an edge by mutate?");
  await N.mutate(a.id, { edges: [b.id] });
  expect(N.get(a.id)?.edges).toEqual([b.id]);
  expect(N.get(b.id)?.edges).toContain(a.id);
});

test("mutate removes the reverse edge of a peer it drops", async () => {
  const b = await N.create("Which node gets dropped from the edge list?");
  const c = await N.create("Which node replaces the dropped peer?");
  const a = await N.create("Which node re-points its edges?", [b.id]);
  expect(N.get(b.id)?.edges).toContain(a.id);

  await N.mutate(a.id, { edges: [c.id] });
  // A reverse edge to a node that no longer claims the peer is a dangling link the graph still walks.
  expect(N.get(b.id)?.edges ?? []).not.toContain(a.id);
  expect(N.get(c.id)?.edges).toContain(a.id);
});

test("clearing edges by mutate unmirrors every peer", async () => {
  const b = await N.create("Which node is unlinked when edges are cleared?");
  const a = await N.create("Which node clears its edges?", [b.id]);
  await N.mutate(a.id, { edges: [] });
  expect(N.get(a.id)?.edges).toEqual([]);
  expect(N.get(b.id)?.edges ?? []).not.toContain(a.id);
});

test("a mutate that does not mention edges leaves the mirrored link intact", async () => {
  const b = await N.create("Which node keeps its link across a partial mutate?");
  const a = await N.create("Which node is answered without touching edges?", [b.id]);
  await N.mutate(a.id, { answer: "Answered without touching edges.", citation: "probe" });
  expect(N.get(a.id)?.edges).toEqual([b.id]);
  expect(N.get(b.id)?.edges).toContain(a.id);
});

test("mutate returns the edges that were actually stored", async () => {
  const b = await N.create("Which node is returned in the mutate result?");
  const a = await N.create("Which node reports its stored edges?");
  const returned = await N.mutate(a.id, { edges: [b.id, b.id, a.id] });
  // Self-links and duplicates are dropped on write; the caller must not be told otherwise.
  expect(returned?.edges).toEqual([b.id]);
  expect(returned?.edges).toEqual(N.get(a.id)?.edges);
});

test("delete removes the node and every reverse edge pointing at it", async () => {
  const peer = await N.create("Which node survives its neighbour being deleted?");
  const doomed = await N.create("Which node is deleted?", [peer.id]);
  expect(N.get(peer.id)?.edges).toContain(doomed.id);

  expect(N.remove(doomed.id)).toBe(true);
  expect(N.get(doomed.id)).toBeNull();
  expect(N.get(peer.id)?.edges ?? []).not.toContain(doomed.id);
  expect(N.remove(doomed.id)).toBe(false);
});
