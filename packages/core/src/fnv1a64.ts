/** FNV-1a over UTF-16 code units, matching the persisted BigInt fingerprints. */
export function fnv1a64(value: string): string {
  let high = 0xcbf29ce4;
  let low = 0x84222325;
  for (let index = 0; index < value.length; index += 1) {
    const mixed = (low ^ value.charCodeAt(index)) >>> 0;
    // 0x100000001b3 = 2^40 + 435. The low-word product fits exactly
    // in a JS number; its carry and the shifted low word form the high word.
    const product = mixed * 435;
    high =
      (Math.imul(high, 435) +
        (mixed << 8) +
        Math.floor(product / 0x100000000)) >>>
      0;
    low = product >>> 0;
  }
  return high.toString(16).padStart(8, "0") + low.toString(16).padStart(8, "0");
}
