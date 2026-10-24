/** Keep the largest already-ordered subsequence at its persisted ranks. */
export function orderedRanks(
  keys: readonly string[],
  previous: Map<string, number>,
): number[] {
  const known = keys.map((key) => previous.get(key));
  // The usual feedback/checkpoint moves a few sightings to the end. Its
  // ordered prefix already has valid ranks; finding an LIS for every one of
  // 37,000 untouched rows adds work without changing the chosen anchors.
  let prefix = 0;
  let previousRank = -Infinity;
  while (prefix < known.length) {
    const rank = known[prefix];
    if (rank === undefined || !(rank > previousRank)) break;
    previousRank = rank;
    prefix += 1;
  }
  if (prefix === known.length) return known as number[];
  if (
    known.length >= 256 &&
    prefix >= known.length * 0.9 &&
    known.length - prefix <= 2_048 &&
    known
      .slice(prefix)
      .every((rank) => rank === undefined || rank <= previousRank)
  ) {
    let maximum = previousRank;
    for (const rank of previous.values()) maximum = Math.max(maximum, rank);
    const ranks = known.slice(0, prefix) as number[];
    for (let index = prefix; index < known.length; index += 1)
      ranks.push(maximum + index - prefix + 1);
    if (
      ranks.every(
        (rank, index) =>
          Number.isFinite(rank) && (index === 0 || rank > ranks[index - 1]!),
      )
    )
      return ranks;
  }
  const tails: number[] = [];
  // Each index's predecessor in the subsequence (-1: none), and the anchors.
  const links = new Int32Array(keys.length).fill(-1);
  for (const [index, rank] of known.entries()) {
    if (rank === undefined) continue;
    let low = 0;
    let high = tails.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (known[tails[middle]!]! < rank) low = middle + 1;
      else high = middle;
    }
    if (low > 0) links[index] = tails[low - 1]!;
    tails[low] = index;
  }
  const anchorFlags = new Uint8Array(keys.length);
  const anchors = { has: (index: number) => anchorFlags[index] === 1 };
  let cursor = tails.at(-1) ?? -1;
  while (cursor >= 0) {
    anchorFlags[cursor] = 1;
    cursor = links[cursor]!;
  }
  const ranks: number[] = [];
  let maximum = -1;
  for (const rank of previous.values()) maximum = Math.max(maximum, rank);
  let start = 0;
  for (let end = 0; end <= keys.length; end += 1) {
    if (end < keys.length && !anchors.has(end)) continue;
    const right = end < keys.length ? known[end]! : undefined;
    const left = start > 0 ? ranks[start - 1]! : undefined;
    const count = end - start;
    for (let offset = 0; offset < count; offset += 1) {
      // SQLite's non-STRICT numeric position column accepts fractional ranks.
      // Mid-list inserts use the existing gap without shifting later rows;
      // append/move-to-end ranks are strictly above the previous maximum.
      ranks[start + offset] =
        right === undefined
          ? Math.max(maximum, left ?? -1) + offset + 1
          : left === undefined
            ? right - count + offset
            : left + (right - left) * ((offset + 1) / (count + 1));
    }
    if (right !== undefined) ranks[end] = right;
    start = end + 1;
  }
  // Compact only when floating-point gaps or extreme ranks are exhausted.
  // Never publish a rank collision that could reorder canonical state on reopen.
  if (
    ranks.some(
      (rank, index) =>
        !Number.isFinite(rank) || (index > 0 && rank <= ranks[index - 1]!),
    )
  )
    return keys.map((_, index) => index);
  return ranks;
}
