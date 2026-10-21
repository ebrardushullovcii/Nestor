/**
 * Keeps the last result while the input holds the same frozen elements in the
 * same order. Workspace reads build a new array of the same cached job views
 * on every refresh, so caching by array identity never hits; checking a few
 * thousand references is far cheaper than ordering the jobs again.
 *
 * Inputs with any unfrozen element are computed every time, since their
 * contents could change without their identity changing.
 */
export function memoizeBySameElements<T, R>(
  compute: (input: readonly T[]) => R,
): (input: readonly T[]) => R {
  let last: { input: readonly T[]; output: R } | null = null;
  return (input) => {
    if (
      last &&
      last.input.length === input.length &&
      input.every((item, index) => item === last!.input[index])
    ) {
      return last.output;
    }
    const output = compute(input);
    last = input.every((item) => Object.isFrozen(item))
      ? { input: input.slice(), output }
      : null;
    return output;
  };
}

/**
 * A frozen, sorted copy of the input, kept between calls. When most of the
 * frozen elements are the ones sorted last time, the departed ones are
 * dropped and the new ones merged in: changing one job of 6,000 no longer
 * sorts all of them again. `compare` must be a total order over distinct
 * elements and depend only on the (frozen) elements themselves.
 */
export function memoizeSortedBySameElements<T extends object>(
  compare: (left: T, right: T) => number,
): (input: readonly T[]) => T[] {
  let last: { input: readonly T[]; output: readonly T[] } | null = null;
  return (input) => {
    if (
      last &&
      last.input.length === input.length &&
      input.every((item, index) => item === last!.input[index])
    ) {
      return last.output as T[];
    }
    const frozen = input.every((item) => Object.isFrozen(item));
    const output =
      (frozen && last ? mergeChanges(last, input, compare) : null) ??
      [...input].sort(compare);
    Object.freeze(output);
    last = frozen ? { input: input.slice(), output } : null;
    return output;
  };
}

function mergeChanges<T extends object>(
  last: { input: readonly T[]; output: readonly T[] },
  input: readonly T[],
  compare: (left: T, right: T) => number,
): T[] | null {
  const current = new Set(input);
  const previous = new Set(last.input);
  // Repeated elements make "the same elements" ambiguous; sort those fully.
  if (current.size !== input.length || previous.size !== last.input.length)
    return null;
  const added = input.filter((item) => !previous.has(item));
  const removed = last.input.length - (input.length - added.length);
  if (added.length + removed > Math.max(64, input.length / 8)) return null;
  added.sort(compare);
  const kept = last.output.filter((item) => current.has(item));
  const merged: T[] = [];
  let from = 0;
  for (const item of added) {
    let low = from;
    let high = kept.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (compare(kept[middle]!, item) <= 0) low = middle + 1;
      else high = middle;
    }
    for (let index = from; index < low; index += 1) merged.push(kept[index]!);
    merged.push(item);
    from = low;
  }
  for (let index = from; index < kept.length; index += 1)
    merged.push(kept[index]!);
  return merged;
}
