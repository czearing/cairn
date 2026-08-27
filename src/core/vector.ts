// Embeddings are stored as packed float32 BLOBs: ~5x smaller than a JSON decimal array and zero-parse
// to load, which is what lets brute-force search stay fast as the brain grows.
//
// Two invariants make this safe everywhere:
//   • Cross-OS / cross-device: bytes are written and read as EXPLICIT little-endian via DataView (not a
//     platform-dependent Float32Array cast), so a vector encoded on one OS decodes byte-identically on
//     any other — required for cloud sync between mixed-OS devices.
//   • Backward compatible: decodeVector also accepts the legacy JSON-string format, so an existing
//     brain keeps working unchanged before (or without) migration. Nothing is broken on upgrade.

/** Pack a vector into a little-endian float32 BLOB. */
export function encodeVector(vec: number[] | Float32Array): Uint8Array {
  if (vec instanceof Float32Array) {
    return new Uint8Array(vec.buffer, vec.byteOffset, vec.byteLength);
  }
  const f32 = new Float32Array(vec);
  return new Uint8Array(f32.buffer, f32.byteOffset, f32.byteLength);
}

/** Read a stored embedding into a number[]. Accepts the current BLOB format AND the legacy JSON string
 *  (a Buffer is a Uint8Array, so libSQL's BLOBs are covered too). Returns null on anything unreadable. */
export function decodeVector(value: unknown): number[] | null {
  if (value == null) return null;
  // Legacy rows: the embedding was a JSON-stringified array.
  if (typeof value === "string") {
    try {
      const v = JSON.parse(value);
      return Array.isArray(v) ? (v as number[]) : null;
    } catch {
      return null;
    }
  }
  // Current rows: a packed little-endian float32 BLOB.
  if (value instanceof Uint8Array) {
    const byteLength = value.byteLength;
    const n = Math.floor(byteLength / 4);
    if (n === 0) return [];
    if (value.byteOffset % 4 === 0) {
      return Array.from(new Float32Array(value.buffer, value.byteOffset, n));
    }
    const copy = new Uint8Array(byteLength);
    copy.set(value);
    return Array.from(new Float32Array(copy.buffer, 0, n));
  }
  return null;
}
