import { expect, test } from "vitest";
import { fnv1a64 } from "./fnv1a64";

function persistedFingerprint(value: string): string {
  let hash = 0xcbf29ce484222325n;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= BigInt(value.charCodeAt(index));
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, "0");
}

test("preserves existing fingerprints including UTF-16 and carries", () => {
  const samples = [
    "",
    "a",
    "hello",
    "\u0000\uffff\ud83d\ude80",
    "Software engineer\n".repeat(3),
  ];
  let state = 123456789;
  for (let length = 1; length <= 16; length *= 2) {
    let value = "";
    for (let index = 0; index < length; index += 1) {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      value += String.fromCharCode(state >>> 16);
    }
    samples.push(value);
  }
  for (const sample of samples)
    expect(fnv1a64(sample)).toBe(persistedFingerprint(sample));
});
