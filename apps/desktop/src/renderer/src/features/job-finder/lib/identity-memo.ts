/**
 * Remembers the last result of a pure derivation per input object, across
 * component mounts.
 *
 * Workspace collections are immutable: a change produces a new array and an
 * unchanged collection keeps its identity. A `useMemo` forgets its value when
 * the screen unmounts, so every visit to Find jobs re-grouped and re-sorted
 * thousands of jobs that had not changed. Keyed by the input's identity (plus
 * any extra arguments, compared with `Object.is`), the second visit gets the
 * same result back, and that result keeps its identity too, so memos further
 * down hit as well.
 *
 * Only for pure functions of their arguments; the cache holds one entry per
 * input object and lets it go with the object.
 */
export function createIdentityMemo<
  Key extends object,
  Extra extends readonly unknown[],
  Result,
>(
  compute: (key: Key, ...extra: Extra) => Result,
): (key: Key, ...extra: Extra) => Result {
  const cache = new WeakMap<Key, { extra: Extra; result: Result }>();
  return (key, ...extra) => {
    const hit = cache.get(key);
    if (
      hit &&
      hit.extra.length === extra.length &&
      hit.extra.every((value, index) => Object.is(value, extra[index]))
    ) {
      return hit.result;
    }
    const result = compute(key, ...extra);
    cache.set(key, { extra, result });
    return result;
  };
}

/**
 * A per-object derived value computed once: list rows are immutable, so what
 * a row shows or is searched by never changes while the row object lives.
 */
export function createPerObjectCache<Key extends object, Value>(
  compute: (key: Key) => Value,
): (key: Key) => Value {
  const cache = new WeakMap<Key, Value>();
  return (key) => {
    const cached = cache.get(key);
    if (cached !== undefined || cache.has(key)) return cached as Value;
    const value = compute(key);
    cache.set(key, value);
    return value;
  };
}
