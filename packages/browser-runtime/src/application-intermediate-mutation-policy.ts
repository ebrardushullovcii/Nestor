// One field change on a real form fans out into validation, autosave and
// analytics calls, and a slow site answers late; the window is sized for
// that, not for one request.
export const INTERMEDIATE_MUTATION_WINDOW_MAX_REQUESTS = 40;
export const INTERMEDIATE_MUTATION_WINDOW_DURATION_MS = 10_000;

export type IntermediateMutationResourceKind =
  | "fetch"
  | "xhr"
  | "send_beacon"
  | "websocket"
  | "eventsource"
  | "webtransport"
  | "other";

export type IntermediateMutationDecisionReason =
  | "not_authorized"
  | "window_closed"
  | "window_expired"
  | "window_exhausted"
  | "unsupported_transport"
  | "unsafe_method"
  | "invalid_url"
  | "cross_origin"
  | "final_action_signal"
  | "ambiguous_mutation"
  | "allowed_intermediate_mutation";

export interface IntermediateMutationWindowSnapshot {
  expectedOrigin: string;
  expiresAtMs: number;
  remainingRequests: number;
}

export interface IntermediateMutationRequestInput {
  authorized: boolean;
  bodyText?: string | null;
  method: string;
  nowMs: number;
  resourceKind: IntermediateMutationResourceKind;
  url: string | null;
  window: IntermediateMutationWindowSnapshot | null;
}

export interface IntermediateMutationDecision {
  allowed: boolean;
  reason: IntermediateMutationDecisionReason;
}

const ALLOWED_METHODS = new Set(["POST", "PUT", "PATCH"]);
const ALLOWED_RESOURCE_KINDS = new Set<IntermediateMutationResourceKind>([
  "fetch",
  "xhr",
]);

export const FINAL_ACTION_SIGNAL =
  /(?:^|[^a-z0-9])(?:submit|submission|finali[sz]e|complete[-_\s]*(?:the[-_\s]*)?application|send[-_\s]*application|apply[-_\s]*(?:to[-_\s]*job|now|job)|create[-_\s]*(?:account|application|user)|register)(?:[^a-z0-9]|$)|\/(?:apply|submit)(?=\/|\s|[?#]|$)|\/applications\/?(?=\s|[?#]|$)|(?:^|[^a-z0-9])(?:is[-_\s]*)?final["']?\s*(?::|=|,|\r?\n\s*\r?\n)\s*["']?(?:true|1|on|yes)(?=["'\s,}&\]]|$)/iu;
const INTERMEDIATE_ACTION_SIGNAL =
  /(?:^|[^a-z0-9])(?:autosave|auto[-_\s]*save|draft|save[-_\s]*(?:field|answer|progress|draft)?|update[-_\s]*(?:field|answer|progress|draft|application|form)?|field|answer|attachment|upload|progress)(?:[^a-z0-9]|$)/iu;

function normalizeMethod(method: string): string {
  return method.trim().toUpperCase();
}

function buildInspectableSignal(input: {
  bodyText?: string | null;
  url: URL;
}): string {
  const body = input.bodyText ?? "";
  const safeDecode = (value: string): string => {
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  };
  return `${safeDecode(input.url.pathname)} ${safeDecode(input.url.search)} ${safeDecode(body)}`
    .replace(/\\(["'])/gu, "$1")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2");
}

/**
 * Fail-closed, provider-neutral request classification for a single bounded
 * field-mutation window. The decision never returns or persists request bodies;
 * text is inspected in-memory only for operation semantics.
 */
export function classifyIntermediateMutationRequest(
  input: IntermediateMutationRequestInput,
): IntermediateMutationDecision {
  if (!input.authorized) {
    return { allowed: false, reason: "not_authorized" };
  }
  if (!input.window) {
    return { allowed: false, reason: "window_closed" };
  }
  if (input.nowMs > input.window.expiresAtMs) {
    return { allowed: false, reason: "window_expired" };
  }
  if (input.window.remainingRequests <= 0) {
    return { allowed: false, reason: "window_exhausted" };
  }
  if (!ALLOWED_RESOURCE_KINDS.has(input.resourceKind)) {
    return { allowed: false, reason: "unsupported_transport" };
  }
  if (!ALLOWED_METHODS.has(normalizeMethod(input.method))) {
    return { allowed: false, reason: "unsafe_method" };
  }

  let parsedUrl: URL;
  try {
    if (!input.url) {
      throw new Error("missing URL");
    }
    parsedUrl = new URL(input.url);
  } catch {
    return { allowed: false, reason: "invalid_url" };
  }
  if (parsedUrl.origin !== input.window.expectedOrigin) {
    return { allowed: false, reason: "cross_origin" };
  }

  if ((input.bodyText?.length ?? 0) > 65_536)
    return { allowed: false, reason: "ambiguous_mutation" };
  const signal = buildInspectableSignal({
    bodyText: input.bodyText ?? null,
    url: parsedUrl,
  });
  if (FINAL_ACTION_SIGNAL.test(signal)) {
    return { allowed: false, reason: "final_action_signal" };
  }
  if (!INTERMEDIATE_ACTION_SIGNAL.test(signal)) {
    return { allowed: false, reason: "ambiguous_mutation" };
  }

  return { allowed: true, reason: "allowed_intermediate_mutation" };
}
