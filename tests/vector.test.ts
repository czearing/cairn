import { test, expect, describe } from "bun:test";
import { encodeVector, decodeVector } from "../src/core/vector";

describe("vector encode/decode", () => {
  test("round-trips a vector exactly at float32 precision", () => {
    const v = [0.5, -0.25, 0.123456789, 1, -1, 0];
    const back = decodeVector(encodeVector(v));
    // encode rounds each double to float32, so the exact expectation is Math.fround.
    expect(back).toEqual(v.map(Math.fround));
  });

  test("byte layout is explicit little-endian (cross-OS guarantee)", () => {
    // 1.0 in IEEE-754 float32 little-endian is 00 00 80 3F.
    expect(Array.from(encodeVector([1]))).toEqual([0x00, 0x00, 0x80, 0x3f]);
    // -2.0 is 00 00 00 C0.
    expect(Array.from(encodeVector([-2]))).toEqual([0x00, 0x00, 0x00, 0xc0]);
  });

  test("BLOB length is 4 bytes per float", () => {
    expect(encodeVector(new Array(384).fill(0)).byteLength).toBe(384 * 4);
  });

  test("decodes the legacy JSON-string format (don't break old brains)", () => {
    expect(decodeVector(JSON.stringify([1, 2, 3]))).toEqual([1, 2, 3]);
  });

  test("a Buffer (libSQL BLOB) decodes the same as a Uint8Array", () => {
    const u8 = encodeVector([0.1, 0.2, 0.3]);
    const fromBuffer = decodeVector(Buffer.from(u8)); // Buffer is a Uint8Array subclass
    expect(fromBuffer).toEqual(decodeVector(u8));
  });

  test("decode tolerates a non-zero byteOffset (sqlite may return a view)", () => {
    const u8 = encodeVector([0.1, 0.2, 0.3]);
    const padded = new Uint8Array(u8.byteLength + 8);
    padded.set(u8, 5); // offset by 5 bytes
    const view = padded.subarray(5, 5 + u8.byteLength);
    expect(decodeVector(view)).toEqual(decodeVector(u8));
  });

  test("returns null for null / unreadable values", () => {
    expect(decodeVector(null)).toBeNull();
    expect(decodeVector(undefined)).toBeNull();
    expect(decodeVector("not json")).toBeNull();
    expect(decodeVector(42)).toBeNull();
  });
});
