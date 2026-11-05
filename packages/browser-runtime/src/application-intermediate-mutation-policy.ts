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

// "Autocomplete" in an operation's name is a search (Ashby's location
// picker), never a step that completes the application.
export const FINAL_ACTION_SIGNAL =
  /(?:^|[^a-z0-9])(?:submit(?:ted|ting)?|submission|finali[sz]e|complete[-_\s]*(?:the[-_\s]*)?application|send[-_\s]*application|apply[-_\s]*(?:to[-_\s]*job|now|job)|create[-_\s]*(?:account|application|user)|register)(?:[^a-z0-9]|$)|\/(?:apply|submit|complete|send)(?=\/|\s|[?#.;]|$)|\/(?:applications?|applicants?|candidates?)(?:\/(?:new|create))?\/?(?=\s|[?#.;]|$)|(?:^|[^a-z0-9])(?:is[-_\s]*)?(?:final|complete(?:d)?)["']?\s*(?::|=|,|\r?\n\s*\r?\n)\s*["']?(?:true|1|on|yes)(?=["'\s,}&\]]|$)|(?:^|[^a-z0-9])(?:is[-_\s]*)?draft["']?\s*(?::|=|,|\r?\n\s*\r?\n)\s*["']?(?:false|0|off|no)(?=["'\s,}&\]]|$)|(?:^|[^a-z0-9])step["']?\s*(?::|=|,|\r?\n\s*\r?\n)\s*["']?final(?=["'\s,}&\]]|$)|(?:^|[^a-z0-9])status["']?\s*(?::|=|,|\r?\n\s*\r?\n)\s*["']?(?:sent|applied)(?=["'\s,}&\]]|$)|(?:^|[^a-z0-9])(?:state|phase)["']?\s*(?::|=|,|\r?\n\s*\r?\n)\s*["']?final(?=["'\s,}&\]]|$)|(?:^|[^a-z0-9])final[-_\s]*step["']?\s*(?::|=|,|\r?\n\s*\r?\n)\s*["']?(?:true|1|on|yes)(?=["'\s,}&\]]|$)|(?:^|[^a-z0-9])action["']?\s*(?::|=|,|\r?\n\s*\r?\n)\s*["']?(?:publish|send|confirm|submit|finish|apply)(?=["'\s,}&\]]|$)|(?:^|[^a-z0-9])operation[-_\s]*name["']?\s*(?::|=|,|\r?\n\s*\r?\n)\s*["']?[a-z0-9_\s-]*(?:apply|submit|finish|(?<!auto)complete)[a-z0-9_\s-]*(?=["',}&\]]|$)|\b(?:mutation|query)\s+[a-z0-9_\s-]*(?:apply|submit|finish|(?<!auto)complete)[a-z0-9_\s-]*(?=\s*[({])/iu;

/** Self-contained: install the identical completion policy in each guarded frame. */
export function hasUnsafeStepCompletion(bodyText?: string): boolean {
  if (bodyText === undefined) {
    if (typeof window !== "undefined")
      (
        window as unknown as Record<string, unknown>
      ).__nestorUnsafeStepCompletion = hasUnsafeStepCompletion;
    return false;
  }
  const completion =
    /["']?(?:status|state|phase|step[-_\s]*status)["']?\s*(?::|=|,)\s*["']?(?:complete(?:d)?|done)(?=["'\s,}&\]]|$)/giu;
  let value: unknown;
  try {
    value = JSON.parse(bodyText);
    for (let pass = 0; pass < 3 && typeof value === "string"; pass++)
      value = JSON.parse(value);
  } catch {
    try {
      const fields = [...new URLSearchParams(bodyText)];
      if (!fields.length || fields.some(([key]) => /[{}[\]"]/u.test(key)))
        return completion.test(bodyText);
      if (new Set(fields.map(([key]) => key)).size !== fields.length)
        return true;
      value = Object.fromEntries(fields);
    } catch {
      return completion.test(bodyText);
    }
  }
  let seen = 0;
  const walk = (node: unknown, depth: number): boolean => {
    if (depth > 8) return true;
    if (typeof node === "string" && /^\s*[[{]/u.test(node))
      return hasUnsafeStepCompletion(node);
    if (!node || typeof node !== "object") return false;
    if (Array.isArray(node)) {
      if (
        node.every(
          (entry) =>
            Array.isArray(entry) &&
            entry.length === 2 &&
            typeof entry[0] === "string",
        )
      ) {
        const fields = node as [string, unknown][];
        if (new Set(fields.map(([key]) => key)).size !== fields.length)
          return true;
        return walk(Object.fromEntries(fields), depth + 1);
      }
      return node.some((entry) => walk(entry, depth + 1));
    }
    const entries = Object.entries(node as Record<string, unknown>);
    const fields = Object.fromEntries(
      entries.map(([key, item]) => [
        key.replace(/[-_\s]/gu, "").toLowerCase(),
        item,
      ]),
    );
    const truth = (item: unknown) =>
      item === true ||
      (typeof item === "string" && /^(?:true|1|on|yes)$/iu.test(item));
    const falsity = (item: unknown) =>
      item === false ||
      (typeof item === "string" && /^(?:false|0|off|no)$/iu.test(item));
    let nonFinal =
      truth(fields.draft) ||
      truth(fields.isdraft) ||
      falsity(fields.final) ||
      falsity(fields.isfinal);
    const total = fields.totalsteps ?? fields.stepcount ?? fields.numberofsteps;
    const index = fields.stepindex ?? fields.currentstepindex;
    const step =
      index ?? fields.currentstep ?? fields.stepnumber ?? fields.step;
    const numeric = (item: unknown) =>
      typeof item === "number" ||
      (typeof item === "string" && /^\d+$/u.test(item));
    if (numeric(step) && numeric(total)) {
      const current = Number(step),
        count = Number(total);
      nonFinal ||=
        Number.isInteger(current) &&
        Number.isInteger(count) &&
        current >= 0 &&
        count > 1 &&
        (index !== undefined ? current + 1 < count : current < count);
    }
    for (const [key, item] of Object.entries(fields)) {
      if (/^(?:is|has|application)?completed?$/u.test(key) && truth(item))
        return true;
      if (
        /^(?:status|state|phase|stepstatus)$/u.test(key) &&
        typeof item === "string" &&
        /^(?:complete(?:d)?|done)$/iu.test(item)
      ) {
        seen++;
        if (!nonFinal) return true;
      }
      if (walk(item, depth + 1)) return true;
    }
    return false;
  };
  if (walk(value, 0)) return true;
  // Lost duplicate keys and opaque completion fields cannot borrow a companion.
  const fields = [
    ...bodyText.matchAll(
      /("(?:\\.|[^"\\])*")\s*:\s*("(?:\\.|[^"\\])*"|true|false|\d+)/gu,
    ),
  ]
    .filter((match) =>
      /^(?:status|state|phase|step[-_\s]*status)$/iu.test(
        String(JSON.parse(match[1]!)),
      ),
    )
    .map((match) => `${match[1]}:${match[2]}`)
    .join(",");
  return [...fields.matchAll(completion)].length > seen;
}

function normalizeMethod(method: string): string {
  return method.trim().toUpperCase();
}

/** Self-contained, shared by the DOM and network fences. Values stay in memory. */
export function inspectIntermediateMutationSignal(input?: {
  bodyText?: string | null;
  url: string;
  finalActionSignal: string;
}): "final_action_signal" | "ambiguous_mutation" | null {
  if (!input) {
    if (typeof window !== "undefined")
      (
        window as unknown as Record<string, unknown>
      ).__nestorIntermediateSignal = inspectIntermediateMutationSignal;
    return null;
  }
  const body = input.bodyText ?? "";
  if (body.length > 65_536) return "ambiguous_mutation";
  const safeDecode = (value: string): string => {
    let text = value;
    for (let pass = 0; pass < 4; pass++) {
      const next = text
        .replace(/(?:%[\da-f]{2})+/giu, (part) => {
          try {
            return decodeURIComponent(part);
          } catch {
            return part;
          }
        })
        .replace(/\\u([\da-f]{4})/giu, (_match: string, hex: string) =>
          String.fromCharCode(Number.parseInt(hex, 16)),
        )
        .replace(/\\(["'\\])/gu, "$1");
      if (next === text) break;
      text = next;
    }
    return text;
  };
  const final = new RegExp(input.finalActionSignal, "iu");
  const semantic = (text: string) =>
    safeDecode(text).replace(/([a-z0-9])([A-Z])/g, "$1 $2");
  const signals: string[] = [];
  try {
    const url = new URL(input.url);
    signals.push(semantic(`${url.pathname} ${url.search}`));
    if (/\/(?:accounts?|users?)(?:\/(?:new|create))?\/?$/iu.test(url.pathname))
      return "final_action_signal";
  } catch {
    return "ambiguous_mutation";
  }
  // GraphQL string literals and comments are data, not operation/field names.
  const graphql = (text: string) =>
    semantic(text.replace(/"""[\s\S]*?"""|"(?:\\.|[^"\\])*"|#[^\r\n]*/gu, " "));
  let value: unknown = {};
  try {
    if (body.trim()) {
      try {
        value = JSON.parse(body);
        for (let pass = 0; pass < 3 && typeof value === "string"; pass++)
          value = JSON.parse(value);
      } catch {
        if (/^\s*(?:mutation|query)\b/u.test(body)) {
          signals.push(graphql(body));
          value = {};
        } else {
          if (!body.includes("=")) return "ambiguous_mutation";
          const fields = [...new URLSearchParams(body)];
          if (
            !fields.length ||
            new Set(fields.map(([key]) => key)).size !== fields.length
          )
            return "ambiguous_mutation";
          value = Object.fromEntries(fields);
        }
      }
    }
    if (!value || typeof value !== "object") return "ambiguous_mutation";
    let visited = 0;
    const walk = (node: unknown, depth: number): void => {
      if (++visited > 2048 || depth > 8) throw new Error("Opaque mutation");
      if (!node || typeof node !== "object") return;
      if (Array.isArray(node)) {
        if (
          node.every(
            (entry) =>
              Array.isArray(entry) &&
              entry.length === 2 &&
              typeof entry[0] === "string",
          )
        ) {
          const entries = node as [string, unknown][];
          if (new Set(entries.map(([key]) => key)).size !== entries.length)
            throw new Error("Duplicate fields");
          walk(Object.fromEntries(entries), depth + 1);
        } else for (const entry of node) walk(entry, depth + 1);
        return;
      }
      for (const [key, item] of Object.entries(
        node as Record<string, unknown>,
      )) {
        const channel =
          /^(?:operationName|query|action|operation|status|state|phase|step)$/iu.test(
            key,
          );
        signals.push(semantic(key));
        if (typeof item === "string") {
          const decoded = safeDecode(item);
          if (/^\s*[[{]/u.test(decoded)) {
            try {
              walk(JSON.parse(decoded), depth + 1);
            } catch {
              throw new Error("Opaque nested mutation");
            }
          }
          if (key.toLowerCase() === "query") signals.push(graphql(decoded));
          else if (
            channel ||
            (decoded.length <= 64 && /^[\w:.-]+$/u.test(decoded))
          )
            signals.push(semantic(JSON.stringify({ [key]: decoded })));
        } else if (typeof item === "boolean" || typeof item === "number")
          signals.push(semantic(JSON.stringify({ [key]: item })));
        walk(item, depth + 1);
      }
    };
    walk(value, 0);
    // Preserve keys and enum signals even when JSON parsing would discard a
    // duplicate key. Never scan arbitrary free-text answer contents.
    for (const token of body.matchAll(
      /("(?:\\.|[^"\\])*")\s*:\s*("(?:\\.|[^"\\])*"|true|false|\d+)/gu,
    )) {
      const key: unknown = JSON.parse(token[1]!);
      const item: unknown = JSON.parse(token[2]!);
      if (typeof key === "string") walk({ [key]: item }, 0);
    }
  } catch {
    return "ambiguous_mutation";
  }
  if (signals.some((signal) => /\\u[\da-f]{4}|%[\da-f]{2}/iu.test(signal)))
    return "ambiguous_mutation";
  return signals.some((signal) => final.test(signal))
    ? "final_action_signal"
    : null;
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

  const signal = inspectIntermediateMutationSignal({
    bodyText: input.bodyText ?? null,
    url: parsedUrl.href,
    finalActionSignal: FINAL_ACTION_SIGNAL.source,
  });
  if (signal) return { allowed: false, reason: signal };
  if (hasUnsafeStepCompletion(input.bodyText ?? "")) {
    return { allowed: false, reason: "final_action_signal" };
  }

  return { allowed: true, reason: "allowed_intermediate_mutation" };
}
