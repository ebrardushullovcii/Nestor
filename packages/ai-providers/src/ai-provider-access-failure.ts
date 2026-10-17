import { ModelRequestHttpError } from "./model-request-transport";

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
        "The AI service is unavailable because its provider rejected the request for insufficient funds. Nothing was changed. Try again after the service is restored.",
    },
  ],
  [
    401,
    {
      reason: "authentication",
      message:
        "The AI service is unavailable because its provider could not authenticate the request. Nothing was changed. Try again after the service is restored.",
    },
  ],
  [
    403,
    {
      reason: "permission",
      message:
        "The AI service is unavailable because its provider denied access to the service. Nothing was changed. Try again after the service is restored.",
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

/**
 * The provider was still refusing for too many requests after the transport's
 * own retries. Callers running many model requests at once should send fewer.
 */
export function isAiProviderRateLimited(error: unknown): boolean {
  const visited = new Set<Error>();
  let current = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth += 1) {
    if (!(current instanceof Error) || visited.has(current)) return false;
    visited.add(current);
    try {
      if (current instanceof ModelRequestHttpError && current.status === 429)
        return true;
      current = current.cause;
    } catch {
      return false;
    }
  }
  return false;
}
