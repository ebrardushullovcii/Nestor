export * from "./concurrency-limiter";
export { fnv1a64 } from "./fnv1a64";
export { yieldToEventLoop } from "./event-loop-turn";
export {
  rememberRowChanges,
  readRowChanges,
  transferRowChanges,
  type RowChange,
} from "./row-changes";

export type Result<TValue, TError> =
  | { ok: true; value: TValue }
  | { ok: false; error: TError };

export function ok<TValue>(value: TValue): Result<TValue, never> {
  return { ok: true, value };
}

export function fail<TError>(error: TError): Result<never, TError> {
  return { ok: false, error };
}

export function fnv1a32(value: string): string {
  let hash = 0x811c9dc5;
  for (const character of value) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193);
  }
  return `fnv1a32:${(hash >>> 0).toString(16).padStart(8, "0")}`;
}
