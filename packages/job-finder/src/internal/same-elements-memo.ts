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
