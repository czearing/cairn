// Duplicate delivery of one request, not two requests. The engine client mints ids up front and
// retries non-search operations when its request timeout expires, so a slow operation is still
// running when its own retry arrives. Remembering only SETTLED results would let both copies execute
// the same write; the in-flight promise has to be the thing that is remembered.
export interface RequestDeduper<T> {
  run(requestId: string, produce: () => Promise<T>): Promise<T>;
  size(): number;
}

export function createRequestDeduper<T>(maxEntries = 1000): RequestDeduper<T> {
  const pending = new Map<string, Promise<T>>();
  return {
    run(requestId, produce) {
      const prior = pending.get(requestId);
      if (prior) return prior;
      const started = produce();
      pending.set(requestId, started);
      if (pending.size > maxEntries) pending.delete(pending.keys().next().value!);
      // A rejected attempt must not be replayed from cache; only a fresh delivery should re-run it.
      void started.catch(() => { pending.delete(requestId); });
      return started;
    },
    size: () => pending.size,
  };
}
