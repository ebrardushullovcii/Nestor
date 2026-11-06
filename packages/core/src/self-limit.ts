/** A limit imposed by us, rather than a safety stop or a dead connection. */
interface SelfLimitHit {
  readonly limit: string;
  readonly kind: string;
  /** The configured boundary, never the person's data or a model answer. */
  readonly value: number | string | boolean | null;
  readonly where: string;
}

let observeSelfLimit: ((hit: SelfLimitHit) => void) | undefined;
/** Main-process tracing installs this without adding Node imports to core. */
export function setSelfLimitObserver(
  observer: (hit: SelfLimitHit) => void,
): void {
  observeSelfLimit = observer;
}

/** One JSON record per hit, captured by the ordinary app/step logs. */
export function reportSelfLimitHit(hit: SelfLimitHit): void {
  try {
    observeSelfLimit?.(hit);
  } catch {
    /* Observation only. */
  }
  console.warn(
    `[self_limit_hit] ${JSON.stringify({ event: "self_limit_hit", limit: hit.limit, kind: hit.kind, value: hit.value, where: hit.where })}`,
  );
}

/** Page snapshots run in a separate JS realm. Their fixed metadata travels
 * over the console channel and is recorded by the same host reporter.
 */
export function forwardPageSelfLimitHit(message: string): boolean {
  const prefix = "__nestor_self_limit__ ";
  if (!message.startsWith(prefix)) return false;
  try {
    const hit: unknown = JSON.parse(message.slice(prefix.length));
    if (
      hit &&
      typeof hit === "object" &&
      "limit" in hit &&
      typeof hit.limit === "string" &&
      "kind" in hit &&
      typeof hit.kind === "string" &&
      "where" in hit &&
      typeof hit.where === "string" &&
      "value" in hit &&
      (typeof hit.value === "number" ||
        typeof hit.value === "string" ||
        typeof hit.value === "boolean" ||
        hit.value === null)
    ) {
      reportSelfLimitHit({
        limit: hit.limit,
        kind: hit.kind,
        value: hit.value,
        where: hit.where,
      });
    }
  } catch {
    /* Page-owned console messages are untrusted. */
  }
  return true;
}

/** A bounded browser/tool operation reports its own deadline even when a
 * caller catches the timeout and continues with partial evidence.
 */
export function selfLimitTimeout<T>(
  work: Promise<T>,
  value: number,
  where: string,
): Promise<T>;
export function selfLimitTimeout<T>(
  work: Promise<T> | undefined,
  value: number,
  where: string,
): Promise<T | undefined>;
export async function selfLimitTimeout<T>(
  work: Promise<T> | undefined,
  value: number,
  where: string,
): Promise<T | undefined> {
  try {
    return await work;
  } catch (error) {
    if (
      error instanceof Error &&
      (error.name === "TimeoutError" ||
        /\bTimeout \d+ms exceeded\b/u.test(error.message))
    )
      reportSelfLimitHit({
        limit: "operation_timeout",
        kind: "timeout",
        value,
        where,
      });
    throw error;
  }
}

/** Observe evidence/result windows at the point where they actually omit data. */
export function selfLimitSlice(
  value: string,
  start: number,
  end: number | undefined,
  where: string,
): string;
export function selfLimitSlice<T>(
  value: readonly T[],
  start: number,
  end: number | undefined,
  where: string,
): T[];
export function selfLimitSlice(
  value: string | null | undefined,
  start: number,
  end: number | undefined,
  where: string,
): string | null | undefined;
export function selfLimitSlice<T>(
  value: string | readonly T[] | null | undefined,
  start: number,
  end: number | undefined,
  where: string,
): string | T[] | null | undefined {
  if (value == null) return value;
  const result =
    typeof value === "string"
      ? value.slice(start, end)
      : value.slice(start, end);
  if (result.length < value.length)
    reportSelfLimitHit({
      limit: "evidence_window",
      kind: "input",
      value: result.length,
      where,
    });
  return result;
}
