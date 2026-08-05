import { expect, test } from "bun:test";
import {
  citationReferences,
  looksLikeNodeId,
  stripLineSpan,
  unresolvedReferences,
} from "../src/core/citation";

const noNodes = () => false;
const allNodes = () => true;

test("a Windows drive letter is never mistaken for a line span", () => {
  expect(stripLineSpan("C:/Code/cairn/src/core/neurons.ts:186-224"))
    .toBe("C:/Code/cairn/src/core/neurons.ts");
  expect(stripLineSpan("C:/Code/cairn/src/core/neurons.ts")).toBe("C:/Code/cairn/src/core/neurons.ts");
  expect(stripLineSpan("C:/Code/cairn/config.ts:52")).toBe("C:/Code/cairn/config.ts");
  expect(stripLineSpan("https://example.com/page")).toBe("https://example.com/page");
});

test("only a canonical 36-character uuid counts as a thought id", () => {
  expect(looksLikeNodeId("69735b5d-a53c-41ae-9880-0c563bb93def")).toBe(true);
  expect(looksLikeNodeId("b8a36170-0000-0000-0000-000000000000")).toBe(true);
  expect(looksLikeNodeId("69735b5d")).toBe(false);
  expect(looksLikeNodeId("zzzzzzzz-a53c-41ae-9880-0c563bb93def")).toBe(false);
  expect(looksLikeNodeId("69735b5da53c41ae98800c563bb93def0000")).toBe(false);
});

test("a citation is split into the references it names, each classified", () => {
  const references = citationReferences(
    "file:///C:/Code/cairn/src/core/neurons.ts:186-224 ; https://example.com/recipe\nmeasured 2026-08-05 by hand",
  );
  expect(references.map((reference) => reference.kind)).toEqual(["local", "remote", "prose"]);
  expect(references[0]!.path).toBe("C:/Code/cairn/src/core/neurons.ts");
});

test("a fabricated thought id is rejected even though its shape is valid", () => {
  // Both ids below were written from memory during this project and resolved to nothing.
  const citation = "brain node b8a36170-0000-0000-0000-000000000000 supports this";
  expect(unresolvedReferences(citation, noNodes)).toEqual([citation]);
  expect(unresolvedReferences(citation, allNodes)).toEqual([]);
});

test("a path that does not exist is named individually, and a real one passes", () => {
  const real = "file:///C:/Code/cairn/src/core/citation.ts";
  const fake = "file:///C:/Code/cairn/src/core/does-not-exist.ts:12";
  expect(unresolvedReferences(real, allNodes)).toEqual([]);
  expect(unresolvedReferences(`${real} ; ${fake}`, allNodes)).toEqual([fake]);
});

test("a remote url is left to the caller rather than silently treated as proven", () => {
  expect(unresolvedReferences("https://example.com/anything-at-all", noNodes)).toEqual([]);
});
