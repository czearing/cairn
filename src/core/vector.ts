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
export function encodeVector(vec: number[]): Uint8Array {
  const buf = new ArrayBuffer(vec.length * 4);
  const view = new DataView(buf);
  for (let i = 0; i < vec.length; i++) view.setFloat32(i * 4, vec[i]!, true); // true = little-endian
  return new Uint8Array(buf);
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
    const n = value.byteLength >>> 2; // 4 bytes per float
    const view = new DataView(value.buffer, value.byteOffset, value.byteLength);
    const out = new Array<number>(n);
    for (let i = 0; i < n; i++) out[i] = view.getFloat32(i * 4, true);
    return out;
  }
  return null;
}
