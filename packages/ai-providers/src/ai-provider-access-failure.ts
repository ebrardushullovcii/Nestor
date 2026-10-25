import {
  ModelRequestHttpError,
  ModelRequestTimeoutError,
} from "./model-request-transport";

export interface AiProviderAccessFailure {
  readonly reason: "funding" | "authentication" | "permission";
  readonly message: string;
}

const ACCESS_FAILURES = new Map<number, AiProviderAccessFailure>([
  [
    402,
    {
      reason: "funding",
      message:
        "The AI service is unavailable right now. Nothing was changed. Try again after the service is restored.",
    },
  ],
  [
    401,
    {
      reason: "authentication",
      message:
        "The AI service is unavailable right now. Nothing was changed. Try again after the service is restored.",
    },
  ],
  [
    403,
    {
      reason: "permission",
      message:
        "The AI service is unavailable right now. Nothing was changed. Try again after the service is restored.",
    },
  ],
]);
const MAX_CAUSE_DEPTH = 16;

/** Only known AI transport errors qualify; website errors and their messages do not. */
export function getAiProviderAccessFailure(
  error: unknown,
): AiProviderAccessFailure | null {
  const visited = new Set<Error>();
  let current = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth += 1) {
    if (!(current instanceof Error) || visited.has(current)) return null;
    visited.add(current);
    try {
      if (current instanceof ModelRequestHttpError) {
        const failure = ACCESS_FAILURES.get(current.status);
        if (failure) return { ...failure };
      }
      current = current.cause;
    } catch {
      return null;
    }
  }
  return null;
}

function hasModelRequestStatus(
  error: unknown,
  matches: (status: number) => boolean,
): boolean {
  const visited = new Set<Error>();
  let current = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth += 1) {
    if (!(current instanceof Error) || visited.has(current)) return false;
    visited.add(current);
    try {
      if (current instanceof ModelRequestHttpError && matches(current.status))
        return true;
      current = current.cause;
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * The provider was still refusing for too many requests after the transport's
 * own retries. Callers running many model requests at once should send fewer.
 */
export function isAiProviderRateLimited(error: unknown): boolean {
  return hasModelRequestStatus(error, (status) => status === 429);
}

/**
 * The AI service turned the request away for load or its own fault (429 or
 * 5xx), or never finished answering, even after the transport's retries.
 * Nothing is wrong with the request: the same work can run later, so it is
 * put off rather than failed.
 */
export function isAiServiceBusy(error: unknown): boolean {
  return (
    hasModelRequestStatus(error, (status) => status === 429 || status >= 500) ||
    hasCause(error, (cause) => cause instanceof ModelRequestTimeoutError)
  );
}

function hasCause(error: unknown, matches: (cause: Error) => boolean): boolean {
  const visited = new Set<Error>();
  let current = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth += 1) {
    if (!(current instanceof Error) || visited.has(current)) return false;
    visited.add(current);
    try {
      if (matches(current)) return true;
      current = current.cause;
    } catch {
      return false;
    }
  }
  return false;
}
