import {
  ModelRequestHttpError,
  ModelRequestTimeoutError,
  resetModelCredentialRejections,
} from "./model-request-transport";
import {
  describeAiAccessFailure,
  resetAiAccessState,
  runAiAccessRechecks,
  type AiAccessReason,
} from "./ai-provider-access-state";

export {
  AI_ACCESS_MESSAGES,
  AI_ACCESS_STEPS,
  AI_ACCESS_RECHECK_MS,
  aiAccessBlocks,
  aiAccessStatus,
  isAiProviderAccessMessage,
  onAiAccessChange,
  onAiAccessRecheck,
  onAiAccessRefused,
  type AiAccessBlock,
  type AiAccessReason,
  type AiAccessStatus,
} from "./ai-provider-access-state";

export interface AiProviderAccessFailure {
  readonly reason: AiAccessReason;
  /** Plain, and the same for every call: what failed work records. */
  readonly message: string;
  /** The AI service's own words, when it gave any. */
  readonly providerMessage: string | null;
  /** The first web link in those words: its top-up or key page. */
  readonly actionUrl: string | null;
}

const MAX_CAUSE_DEPTH = 16;

/**
 * Check the refused AI account again now, without waiting for the
 * transport's pause: the person says they topped it up or fixed the key.
 * True when waiting work started a call to find out.
 */
export function checkAiAccessAgain(): boolean {
  resetModelCredentialRejections();
  return runAiAccessRechecks();
}

/**
 * The person started work again themselves: let its calls reach the
 * service now instead of answering from the transport's pause.
 */
export function letAiCallsThroughNow(): void {
  resetModelCredentialRejections();
}

/** Test seam: forget refused accounts, their listeners and the transport's pause. */
export function resetAiAccessForTests(): void {
  resetAiAccessState();
  resetModelCredentialRejections();
}

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
        const failure = describeAiAccessFailure(
          current.status,
          current.message,
        );
        if (failure) return failure;
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
  if (getAiProviderAccessFailure(error)) return false;
  return hasModelRequestStatus(error, (status) => status === 429);
}

/**
 * The AI service turned the request away for load or its own fault (429 or
 * 5xx), or never finished answering, even after the transport's retries.
 * Nothing is wrong with the request: the same work can run later, so it is
 * put off rather than failed.
 */
export function isAiServiceBusy(error: unknown): boolean {
  if (getAiProviderAccessFailure(error)) return false;
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
