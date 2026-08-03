import { expect, test } from "bun:test";
import { createRequestDeduper } from "../src/core/request-dedupe";

// The engine client mints the node id before it sends the request and retries every non-search
// operation when its request timeout expires. A slow embed means the original attempt is STILL
// RUNNING when its retry lands, so remembering only settled responses let both copies execute the
// same create and the loser reported "UNIQUE constraint failed: neurons.id" to the agent.
test("a retry that arrives while its original is still running joins it instead of re-executing", async () => {
  const deduper = createRequestDeduper<string>();
  let executions = 0;
  let release!: (value: string) => void;
  const gate = new Promise<string>((resolve) => { release = resolve; });
  const produce = async (): Promise<string> => { executions++; return gate; };

  const first = deduper.run("req-1", produce);
  // The retry is issued while the original is unresolved: this is the case a settled-only cache missed.
  const retry = deduper.run("req-1", produce);
  expect(executions).toBe(1);

  release("neuron-1");
  expect(await first).toBe("neuron-1");
  expect(await retry).toBe("neuron-1");
  expect(executions).toBe(1);
});

test("a settled request is still replayed from cache for a late duplicate", async () => {
  const deduper = createRequestDeduper<number>();
  let executions = 0;
  const produce = async (): Promise<number> => ++executions;
  expect(await deduper.run("req-1", produce)).toBe(1);
  expect(await deduper.run("req-1", produce)).toBe(1);
  expect(executions).toBe(1);
});

test("a rejected request is evicted so a later delivery can run again", async () => {
  const deduper = createRequestDeduper<string>();
  let attempts = 0;
  const produce = async (): Promise<string> => {
    attempts++;
    if (attempts === 1) throw new Error("engine unavailable");
    return "recovered";
  };
  await expect(deduper.run("req-1", produce)).rejects.toThrow("engine unavailable");
  // Caching the failure would make one transient error permanent for that requestId.
  expect(await deduper.run("req-1", produce)).toBe("recovered");
  expect(attempts).toBe(2);
});

test("the cache is bounded so a long-lived engine cannot grow without limit", async () => {
  const deduper = createRequestDeduper<number>(3);
  for (let n = 0; n < 10; n++) await deduper.run(`req-${n}`, async () => n);
  expect(deduper.size()).toBeLessThanOrEqual(3);
});
